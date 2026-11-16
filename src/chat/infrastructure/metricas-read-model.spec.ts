import type { DataSource } from 'typeorm';
import { Channel, Party } from '../domain/chat.enums';
import {
  MetricasReadModel,
  SQL_CHATS,
  SQL_CONVERSACIONES,
  SQL_EN_VIVO,
  SQL_ESPERANDO,
  SQL_PLANTILLAS,
  SQL_RESUELTAS_SIN_PERSONA,
  SQL_TICKETS,
  SQL_TICKETS_EN_VIVO,
  SQL_TRAZAS,
  SQL_USO_POR_EMPRESA,
} from './metricas-read-model';

const A = '11111111-1111-4111-8111-111111111111';
const RANGO = {
  desde: new Date('2026-11-01T03:00:00Z'),
  hasta: new Date('2026-11-17T03:00:00Z'),
};

function conBase(respuestas: unknown[][]) {
  const query = jest.fn((sql: string, params: unknown[]) =>
    Promise.resolve(sql && params ? (respuestas.shift() ?? []) : []),
  );
  return {
    query,
    lectura: new MetricasReadModel({ query } as unknown as DataSource),
  };
}

describe('MetricasReadModel', () => {
  it('lo de una empresa filtra siempre por su `distributor_id` (primer parámetro)', () => {
    for (const sql of [SQL_CONVERSACIONES, SQL_EN_VIVO, SQL_PLANTILLAS]) {
      expect(sql).toMatch(/"distributor_id" = \$1/);
    }
    // Las que sirven a la plataforma: la empresa pedida o todas (nula).
    for (const sql of [
      SQL_TRAZAS,
      SQL_RESUELTAS_SIN_PERSONA,
      SQL_CHATS,
      SQL_ESPERANDO,
      SQL_TICKETS_EN_VIVO,
      SQL_TICKETS,
      SQL_USO_POR_EMPRESA,
    ]) {
      expect(sql).toContain('($1::uuid IS NULL OR');
      expect(sql).toContain('= $1::uuid)');
    }
  });

  it('nunca lee el texto de un mensaje', () => {
    for (const sql of [
      SQL_CONVERSACIONES,
      SQL_EN_VIVO,
      SQL_PLANTILLAS,
      SQL_TRAZAS,
      SQL_RESUELTAS_SIN_PERSONA,
      SQL_CHATS,
      SQL_ESPERANDO,
      SQL_USO_POR_EMPRESA,
    ]) {
      expect(sql).not.toMatch(
        /"body"|"preview"|"last_message_preview"|"comment"/,
      );
    }
  });

  it('conversaciones del período: parámetros y fechas', async () => {
    const { query, lectura } = conBase([
      [
        {
          channel: 'staff_customer',
          created_at: '2026-11-16T11:00:00Z',
          first_incoming_at: '2026-11-16T11:00:00Z',
          first_response_at: null,
          closed_at: '2026-11-16T12:00:00Z',
          closed_reason: 'manual',
        },
      ],
    ]);
    const filas = await lectura.conversacionesDelPeriodo(
      A,
      [Channel.STAFF_CUSTOMER],
      RANGO,
    );
    expect(query).toHaveBeenCalledWith(SQL_CONVERSACIONES, [
      A,
      RANGO.desde,
      RANGO.hasta,
      [Channel.STAFF_CUSTOMER],
    ]);
    expect(filas).toEqual([
      {
        channel: Channel.STAFF_CUSTOMER,
        createdAt: new Date('2026-11-16T11:00:00Z'),
        firstIncomingAt: new Date('2026-11-16T11:00:00Z'),
        firstResponseAt: null,
        closedAt: new Date('2026-11-16T12:00:00Z'),
        closedReason: 'manual',
      },
    ]);
  });

  it('en vivo, plantillas y encuesta: conteos a número', async () => {
    const { query, lectura } = conBase([
      [
        {
          channel: 'staff_driver',
          open: '2',
          unassigned: '1',
          unanswered: '0',
          awaitingHuman: '0',
        },
      ],
      [{ kind: 'quick', key: 'saludo', n: '3' }],
      [{ served_by: 'team', score: 5, n: '1', vencidas: '0' }],
    ]);
    expect(await lectura.enVivo(A, [Channel.STAFF_DRIVER])).toEqual([
      {
        channel: Channel.STAFF_DRIVER,
        open: 2,
        unassigned: 1,
        unanswered: 0,
        awaitingHuman: 0,
      },
    ]);
    expect(
      await lectura.usoDePlantillas(A, [Channel.STAFF_DRIVER], RANGO),
    ).toEqual([{ kind: 'quick', key: 'saludo', count: 3 }]);
    const ahora = new Date('2026-11-16T15:00:00Z');
    await lectura.encuestas(A, RANGO, ahora);
    // La encuesta usa `<=` hasta: el último instante antes del fin del período.
    expect(query).toHaveBeenLastCalledWith(expect.any(String), [
      A,
      RANGO.desde,
      new Date(RANGO.hasta.getTime() - 1),
      ahora,
    ]);
  });

  it('trazas y resueltas sin persona: por canal, parte humana y empresa (o todas)', async () => {
    const { query, lectura } = conBase([
      [
        {
          distributor_id: A,
          outcome: 'handed_off',
          reason: 'timeout',
          n: '2',
          conversaciones: '1',
        },
      ],
      [{ distributor_id: A, n: '1' }],
      [{ distributor_id: A, cerradas: '3', resueltas: '1' }],
    ]);
    const t = await lectura.trazasDelAsistente(
      Channel.PLATFORM_CHAT,
      RANGO,
      null,
    );
    expect(t.trazas).toEqual([
      {
        distributorId: A,
        outcome: 'handed_off',
        reason: 'timeout',
        count: 2,
        conversations: 1,
      },
    ]);
    expect(t.atendidas.get(A)).toBe(1);
    expect(query.mock.calls[0][1]).toEqual([
      null,
      RANGO.desde,
      RANGO.hasta,
      Channel.PLATFORM_CHAT,
    ]);
    expect(
      await lectura.resueltasSinPersona(
        Channel.STAFF_CUSTOMER,
        Party.COMPANY,
        RANGO,
        A,
      ),
    ).toEqual([
      { distributorId: A, closedWithAssistant: 3, resolvedWithoutHuman: 1 },
    ]);
    expect(query).toHaveBeenLastCalledWith(SQL_RESUELTAS_SIN_PERSONA, [
      A,
      RANGO.desde,
      RANGO.hasta,
      Channel.STAFF_CUSTOMER,
      Party.COMPANY,
      // La persona atendida: el cliente en C3 (en C1, la empresa).
      Party.CUSTOMER,
    ]);
    await lectura.resueltasSinPersona(
      Channel.PLATFORM_CHAT,
      Party.PLATFORM,
      RANGO,
      null,
    );
    expect(query.mock.calls.at(-1)?.[1]).toEqual([
      null,
      RANGO.desde,
      RANGO.hasta,
      Channel.PLATFORM_CHAT,
      Party.PLATFORM,
      Party.COMPANY,
    ]);
  });

  it('resueltas sin persona: sin ticket, sin reclamo, sin derivar y, por inactividad, sin pregunta sin contestar', () => {
    expect(SQL_RESUELTAS_SIN_PERSONA).toMatch(
      /NOT EXISTS \(\s*SELECT 1 FROM "support_ticket" t\s*WHERE t\."origin_conversation_id" = c\."conversation_id"/,
    );
    expect(SQL_RESUELTAS_SIN_PERSONA).toContain('c."linked_claim_id" IS NULL');
    expect(SQL_RESUELTAS_SIN_PERSONA).toContain(`"outcome" = 'handed_off'`);
    expect(SQL_RESUELTAS_SIN_PERSONA).toMatch(
      /"closed_reason" <> 'inactivity' OR NOT EXISTS[\s\S]*"sender_party" = \$6[\s\S]*"seq" > \(SELECT max\(r\."seq"\)/,
    );
  });

  it('una empresa dada de baja no existe para las métricas', async () => {
    const { query, lectura } = conBase([[]]);
    expect(await lectura.existeLaEmpresa(A)).toBe(false);
    expect(query.mock.calls[0][0]).toContain('"deletedAt" IS NULL');
  });

  it('plataforma: chats, esperando, tickets, uso y existencia de la empresa', async () => {
    const { lectura } = conBase([
      [
        {
          created_at: '2026-11-16T12:00:00Z',
          first_company_at: '2026-11-16T12:00:00Z',
          first_reply_at: null,
          has_ticket: true,
        },
      ],
      [{ since: '2026-11-16T13:00:00Z' }],
      [{ open: '3', overdue: '1' }],
      [],
      [
        {
          opened_by_party: 'company',
          status: 'resolved',
          created_at: '2026-11-16T12:00:00Z',
          first_response_at: '2026-11-16T12:30:00Z',
          first_response_due_at: null,
          resolved_at: null,
          satisfaction: '4',
        },
      ],
      [
        {
          distributor_id: A,
          name: 'Gas del Sur',
          conversaciones: '5',
          mensajes: '12',
        },
      ],
      [{ '?column?': 1 }],
      [],
    ]);
    expect(await lectura.chatsDeSoporte(RANGO, null)).toEqual([
      {
        createdAt: new Date('2026-11-16T12:00:00Z'),
        firstCompanyAt: new Date('2026-11-16T12:00:00Z'),
        firstReplyAt: null,
        hasTicket: true,
      },
    ]);
    expect(await lectura.chatsEsperando(A)).toEqual([
      new Date('2026-11-16T13:00:00Z'),
    ]);
    expect(await lectura.ticketsEnVivo(new Date(), null)).toEqual({
      open: 3,
      overdue: 1,
    });
    // Sin fila (no debería pasar con count): ceros.
    expect(await lectura.ticketsEnVivo(new Date(), null)).toEqual({
      open: 0,
      overdue: 0,
    });
    expect(await lectura.ticketsDelPeriodo(RANGO, A)).toEqual([
      {
        openedByParty: Party.COMPANY,
        status: 'resolved',
        createdAt: new Date('2026-11-16T12:00:00Z'),
        firstResponseAt: new Date('2026-11-16T12:30:00Z'),
        firstResponseDueAt: null,
        resolvedAt: null,
        satisfaction: 4,
      },
    ]);
    expect(await lectura.usoPorEmpresa(RANGO, null)).toEqual([
      { distributorId: A, name: 'Gas del Sur', conversations: 5, messages: 12 },
    ]);
    expect(await lectura.existeLaEmpresa(A)).toBe(true);
    expect(await lectura.existeLaEmpresa(A)).toBe(false);
  });
});
