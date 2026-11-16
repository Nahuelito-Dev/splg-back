import { MessageKind, MessageVisibility, Party } from './chat.enums';
import { CitaInvalidaError } from './chat.errors';
import {
  armarCita,
  assertRangoValido,
  type MensajeACitar,
  primeraRespuestaEnLaCita,
} from './cita';
import { assertMensajeAdmitido, vistaPrevia } from './reglas-del-mensaje';
import { Channel } from './chat.enums';
import { NotaInternaNoPermitidaError } from './chat.errors';

const m = (seq: number, extra: Partial<MensajeACitar> = {}): MensajeACitar => ({
  messageId: `m${seq}`,
  seq,
  party: seq % 2 ? Party.COMPANY : Party.PLATFORM,
  kind: MessageKind.TEXT,
  visibility: MessageVisibility.ALL,
  body: `texto ${seq}`,
  createdAt: new Date(Date.UTC(2026, 10, 14, 10, seq)),
  redacted: false,
  ...extra,
});

describe('cita del chat en un ticket (§4.2.2, D-C21)', () => {
  it.each([
    [3, 7, 10],
    [1, 1, 1],
    [1, 200, 300],
  ])('%i–%i con %i mensajes vale', (desde, hasta, ultimo) => {
    expect(() => assertRangoValido(desde, hasta, ultimo)).not.toThrow();
  });

  it.each([
    [3, 900, 10],
    [7, 3, 10],
    [0, 3, 10],
    [1, 201, 300],
  ])(
    '%i–%i con %i mensajes es 400 TICKET_EXCERPT_INVALID',
    (desde, hasta, ultimo) => {
      expect(() => assertRangoValido(desde, hasta, ultimo)).toThrow(
        CitaInvalidaError,
      );
    },
  );

  it('copia los mensajes del rango en orden, con el autor como parte y la hora original', () => {
    const mensajes = [m(8), m(3), m(5), m(4), m(7), m(6), m(2)];
    const { payload, citados } = armarCita('chat-a', 3, 7, mensajes);
    expect(payload).toMatchObject({
      sourceConversationId: 'chat-a',
      fromSeq: 3,
      toSeq: 7,
    });
    expect(payload.items.map((i) => i.seq)).toEqual([3, 4, 5, 6, 7]);
    expect(payload.items[0]).toEqual({
      seq: 3,
      party: Party.COMPANY,
      body: 'texto 3',
      at: '2026-11-14T10:03:00.000Z',
    });
    expect(citados).toEqual(['m3', 'm4', 'm5', 'm6', 'm7']);
  });

  it('nunca copia una nota interna y deja sin texto lo redactado', () => {
    const { payload } = armarCita('chat-a', 1, 3, [
      m(1, { visibility: MessageVisibility.INTERNAL }),
      m(2, { redacted: true }),
      m(3),
    ]);
    expect(payload.items).toEqual([
      expect.objectContaining({ seq: 2, body: null }),
      expect.objectContaining({ seq: 3, body: 'texto 3' }),
    ]);
  });

  it('un rango sin nada que citar no sirve', () => {
    expect(() => armarCita('chat-a', 1, 2, [])).toThrow(CitaInvalidaError);
  });

  it('la primera respuesta es el primer mensaje de la plataforma dentro de lo citado', () => {
    const mensajes = [m(1), m(2), m(3), m(4)];
    expect(primeraRespuestaEnLaCita(mensajes, 3, 4)).toEqual(m(4).createdAt);
    expect(primeraRespuestaEnLaCita(mensajes, 1, 1)).toBeNull();
  });
});

describe('reglas del mensaje según el canal', () => {
  it('una nota interna en el chat es 400; en el ticket, sólo de la plataforma', () => {
    const interna = {
      kind: MessageKind.TEXT,
      visibility: MessageVisibility.INTERNAL,
    };
    expect(() =>
      assertMensajeAdmitido(Channel.PLATFORM_CHAT, {
        ...interna,
        party: Party.PLATFORM,
      }),
    ).toThrow(NotaInternaNoPermitidaError);
    expect(() =>
      assertMensajeAdmitido(Channel.PLATFORM_TICKET, {
        ...interna,
        party: Party.COMPANY,
      }),
    ).toThrow(NotaInternaNoPermitidaError);
    expect(() =>
      assertMensajeAdmitido(Channel.PLATFORM_TICKET, {
        ...interna,
        party: Party.PLATFORM,
      }),
    ).not.toThrow();
  });

  it('una cita fuera de un ticket no se admite', () => {
    expect(() =>
      assertMensajeAdmitido(Channel.PLATFORM_CHAT, {
        party: Party.COMPANY,
        kind: MessageKind.QUOTED_EXCERPT,
        visibility: MessageVisibility.ALL,
      }),
    ).toThrow(CitaInvalidaError);
  });

  it('la vista previa nunca sale de una nota interna y se recorta', () => {
    expect(vistaPrevia('secreto', MessageVisibility.INTERNAL)).toBeNull();
    expect(vistaPrevia('  hola\n  che ', MessageVisibility.ALL)).toBe(
      'hola che',
    );
    expect(vistaPrevia('x'.repeat(200), MessageVisibility.ALL)).toHaveLength(
      140,
    );
  });
});
