import {
  type FilaDelHilo,
  motivoParaCallarse,
  puntasDelAsistente,
} from './asistente-del-hilo';
import { Channel, ConversationStatus, MessageKind, Party } from './chat.enums';

const AHORA = new Date('2026-11-10T15:00:00Z');
const hace = (min: number) => new Date(AHORA.getTime() - min * 60_000);
const C3 = puntasDelAsistente(Channel.STAFF_CUSTOMER)!;
const abierta = {
  status: ConversationStatus.OPEN,
  assignedToUserId: null,
  awaitingHumanSince: null,
};
const fila = (
  seq: number,
  senderParty: Party,
  createdAt: Date,
  extra: Partial<FilaDelHilo> = {},
): FilaDelHilo => ({
  seq,
  messageId: `m-${seq}`,
  senderParty,
  kind: MessageKind.TEXT,
  deLaIa: false,
  createdAt,
  retirado: false,
  ...extra,
});
const disparador = { seq: 5, messageId: 'm-5' };

describe('cuándo se encarga el asistente con IA (sobre las filas del hilo, en orden)', () => {
  it('canales: sólo C3 y C1', () => {
    expect(puntasDelAsistente(Channel.STAFF_CUSTOMER)).toEqual({
      pregunta: Party.CUSTOMER,
      atiende: Party.COMPANY,
    });
    expect(puntasDelAsistente(Channel.PLATFORM_CHAT)).toEqual({
      pregunta: Party.COMPANY,
      atiende: Party.PLATFORM,
    });
    expect(puntasDelAsistente(Channel.STAFF_DRIVER)).toBeNull();
    expect(puntasDelAsistente(Channel.PLATFORM_TICKET)).toBeNull();
  });

  it('se encarga del último mensaje del cliente, sin nadie del equipo reciente', () => {
    const filas = [
      fila(2, Party.COMPANY, hace(300)),
      fila(3, Party.SYSTEM, hace(10), { kind: MessageKind.SYSTEM }),
      fila(5, Party.CUSTOMER, AHORA),
    ];
    expect(
      motivoParaCallarse(abierta, filas, disparador, C3, AHORA),
    ).toBeNull();
  });

  it.each<
    [string, Parameters<typeof motivoParaCallarse>[0], FilaDelHilo[], string]
  >([
    [
      'cerrada',
      { ...abierta, status: ConversationStatus.CLOSED },
      [fila(5, Party.CUSTOMER, AHORA)],
      'closed',
    ],
    [
      'mensaje retirado',
      abierta,
      [fila(5, Party.CUSTOMER, AHORA, { retirado: true })],
      'withdrawn',
    ],
    ['mensaje que no está', abierta, [], 'withdrawn'],
    [
      'otro mensaje más nuevo del cliente',
      abierta,
      [fila(5, Party.CUSTOMER, hace(1)), fila(6, Party.CUSTOMER, AHORA)],
      'superseded',
    ],
    [
      'asignada',
      { ...abierta, assignedToUserId: 'adm-1' },
      [fila(5, Party.CUSTOMER, AHORA)],
      'taken',
    ],
    [
      'esperando persona',
      { ...abierta, awaitingHumanSince: hace(5) },
      [fila(5, Party.CUSTOMER, AHORA)],
      'taken',
    ],
    [
      'el equipo escribió hace 119 min',
      abierta,
      [fila(3, Party.COMPANY, hace(119)), fila(5, Party.CUSTOMER, AHORA)],
      'taken',
    ],
    [
      'el equipo contestó después',
      abierta,
      [fila(5, Party.CUSTOMER, hace(1)), fila(6, Party.COMPANY, AHORA)],
      'taken',
    ],
    [
      'la IA contestó después',
      abierta,
      [
        fila(5, Party.CUSTOMER, hace(1)),
        fila(6, Party.SYSTEM, AHORA, {
          kind: MessageKind.AUTO_REPLY,
          deLaIa: true,
        }),
      ],
      'taken',
    ],
  ])('se calla: %s', (_caso, c, filas, motivo) => {
    expect(motivoParaCallarse(c, filas, disparador, C3, AHORA)).toBe(motivo);
  });

  it('no se calla por un mensaje nuevo retirado, una fija (sin IA) posterior ni el equipo de hace más de 2 h', () => {
    const filas = [
      fila(3, Party.COMPANY, hace(121)),
      fila(5, Party.CUSTOMER, hace(1)),
      fila(6, Party.SYSTEM, AHORA, { kind: MessageKind.AUTO_REPLY }),
      fila(7, Party.CUSTOMER, AHORA, { retirado: true }),
    ];
    expect(
      motivoParaCallarse(abierta, filas, disparador, C3, AHORA),
    ).toBeNull();
  });
});
