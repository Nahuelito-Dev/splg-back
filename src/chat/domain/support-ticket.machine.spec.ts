import {
  crearFuncionDeTransicion,
  paresDeTransicion,
} from '../../migrations/sql/transiciones-de-estado';
import { MAQUINA_DEL_TICKET } from '../../migrations/sql/mensajeria';
import { Party, TicketPriority, TicketStatus } from './chat.enums';
import {
  TicketCerradoError,
  TicketNoResueltoError,
  TransicionDeTicketInvalidaError,
} from './chat.errors';
import {
  assertTransicion,
  estadoInicial,
  estadoTrasAsignar,
  estadoTrasConfirmar,
  estadoTrasResponder,
  numeroDeTicket,
  OBJETIVOS_POR_DEFECTO,
  TRANSICIONES_DEL_TICKET,
  vencimientoDelTicket,
  venceLaPrimeraRespuesta,
} from './support-ticket.machine';

const S = TicketStatus;
const ordenar = (t: Readonly<Record<string, readonly string[]>>) =>
  Object.fromEntries(
    Object.keys(t)
      .sort()
      .map((k) => [k, [...t[k]].sort()]),
  );

describe('máquina del ticket (§4.2.2)', () => {
  it('la copia de la base es la del dominio (el trigger rechaza lo mismo)', () => {
    expect(ordenar(MAQUINA_DEL_TICKET.transiciones)).toEqual(
      ordenar(TRANSICIONES_DEL_TICKET),
    );
    const sql = crearFuncionDeTransicion(MAQUINA_DEL_TICKET);
    for (const par of paresDeTransicion(MAQUINA_DEL_TICKET)) {
      expect(sql).toContain(`'${par}'`);
    }
    expect(sql).toContain('CHK_support_ticket_transicion_de_estado');
  });

  it.each([
    [S.NEW, S.OPEN],
    [S.NEW, S.WAITING_COMPANY],
    [S.OPEN, S.WAITING_COMPANY],
    [S.OPEN, S.RESOLVED],
    [S.WAITING_COMPANY, S.OPEN],
    [S.WAITING_COMPANY, S.RESOLVED],
    [S.WAITING_COMPANY, S.CLOSED],
    [S.RESOLVED, S.OPEN],
    [S.RESOLVED, S.CLOSED],
  ])('%s → %s vale', (de, a) => {
    expect(() => assertTransicion(de, a)).not.toThrow();
  });

  it.each([
    [S.NEW, S.RESOLVED],
    [S.NEW, S.CLOSED],
    [S.OPEN, S.CLOSED],
    [S.OPEN, S.NEW],
    [S.CLOSED, S.OPEN],
    [S.CLOSED, S.RESOLVED],
    [S.RESOLVED, S.WAITING_COMPANY],
  ])(
    '%s → %s es 400 TICKET_INVALID_TRANSITION con los estados en castellano',
    (de, a) => {
      const error = (() => {
        try {
          assertTransicion(de, a);
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(error).toBeInstanceOf(TransicionDeTicketInvalidaError);
      expect(error).toMatchObject({ code: 'TICKET_INVALID_TRANSITION' });
      expect((error as Error).message).not.toMatch(/_/);
    },
  );

  it('repetir el estado no es una transición', () => {
    expect(() => assertTransicion(S.CLOSED, S.CLOSED)).not.toThrow();
  });

  it('la empresa abre nuevo; la plataforma, esperando a la empresa', () => {
    expect([
      estadoInicial(Party.COMPANY),
      estadoInicial(Party.PLATFORM),
    ]).toEqual([S.NEW, S.WAITING_COMPANY]);
  });

  it('responder mueve el estado según quién responde', () => {
    const casos = [
      [S.NEW, Party.PLATFORM],
      [S.OPEN, Party.PLATFORM],
      [S.WAITING_COMPANY, Party.PLATFORM],
      [S.RESOLVED, Party.PLATFORM],
      [S.NEW, Party.COMPANY],
      [S.OPEN, Party.COMPANY],
      [S.WAITING_COMPANY, Party.COMPANY],
      [S.RESOLVED, Party.COMPANY],
    ] as const;
    expect(casos.map(([e, p]) => estadoTrasResponder(e, p))).toEqual([
      S.WAITING_COMPANY,
      S.WAITING_COMPANY,
      null,
      null,
      null,
      null,
      S.OPEN,
      S.OPEN,
    ]);
  });

  it('responder en un cerrado es 409 TICKET_CLOSED', () => {
    expect(() => estadoTrasResponder(S.CLOSED, Party.COMPANY)).toThrow(
      TicketCerradoError,
    );
  });

  it('asignar saca de la cola sólo a uno nuevo', () => {
    expect([estadoTrasAsignar(S.NEW), estadoTrasAsignar(S.OPEN)]).toEqual([
      S.OPEN,
      null,
    ]);
  });

  it('la empresa sólo confirma un resuelto', () => {
    expect(estadoTrasConfirmar(S.RESOLVED)).toBe(S.CLOSED);
    expect(() => estadoTrasConfirmar(S.WAITING_COMPANY)).toThrow(
      TicketNoResueltoError,
    );
  });

  describe('cierre automático (reloj fijo)', () => {
    const plazos = {
      waitingCloseDays: 7,
      waitingWarnDays: 5,
      resolvedCloseDays: 7,
    };
    const desde = new Date('2026-11-01T12:00:00Z');
    const dia = (n: number) => new Date(desde.getTime() + n * 86_400_000);

    it('esperando a la empresa: nada antes de 5 días, aviso a los 5, cierre a los 7', () => {
      expect(
        [4.9, 5, 6.9, 7].map((n) =>
          vencimientoDelTicket(S.WAITING_COMPANY, desde, dia(n), plazos),
        ),
      ).toEqual([null, 'warn', 'warn', 'close']);
    });

    it('resuelto: se cierra a los 7 días, sin aviso', () => {
      expect(
        [5, 6.9, 7].map((n) =>
          vencimientoDelTicket(S.RESOLVED, desde, dia(n), plazos),
        ),
      ).toEqual([null, null, 'close']);
    });

    it('nuevo, en curso y cerrado no vencen', () => {
      expect(
        [S.NEW, S.OPEN, S.CLOSED].map((e) =>
          vencimientoDelTicket(e, desde, dia(30), plazos),
        ),
      ).toEqual([null, null, null]);
    });
  });

  it('el objetivo de primera respuesta sale de la prioridad', () => {
    const abierto = new Date('2026-11-14T10:00:00Z');
    expect(
      venceLaPrimeraRespuesta(
        abierto,
        TicketPriority.URGENT,
        OBJETIVOS_POR_DEFECTO,
      ),
    ).toEqual(new Date('2026-11-14T11:00:00Z'));
  });

  it('el número se muestra T-000123', () => {
    expect(numeroDeTicket(123)).toBe('T-000123');
  });
});
