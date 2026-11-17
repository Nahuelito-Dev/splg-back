import { BadRequestException } from '@nestjs/common';
import {
  Channel,
  ConversationClosedReason,
  ConversationStatus,
} from '../domain/chat.enums';
import type {
  ConversacionDelPeriodo,
  MetricasReadModel,
} from '../infrastructure/metricas-read-model';
import type { FilaDelResumen } from './bandeja-encuesta.service';
import { ChatMetricsService } from './chat-metrics.service';
import {
  ajustesDeLaBandejaPorDefecto,
  type CompanyChatSettingsService,
} from './company-chat-settings.service';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
/** Hora argentina (UTC−3) a instante. */
const ar = (diaYHora: string) => new Date(`${diaYHora}:00-03:00`);
const AHORA = ar('2026-11-17T12:00');

const conversacion = (
  c: Partial<ConversacionDelPeriodo>,
): ConversacionDelPeriodo => ({
  conversationId: 'c-1',
  channel: Channel.STAFF_CUSTOMER,
  createdAt: ar('2026-11-16T08:00'),
  firstIncomingAt: ar('2026-11-16T08:00'),
  firstResponseAt: null,
  closedAt: null,
  closedReason: null,
  ...c,
  status:
    c.status ??
    (c.closedAt ? ConversationStatus.CLOSED : ConversationStatus.OPEN),
});

/**
 * Una base falsa con datos SÓLO de la empresa A: cada lectura devuelve lo de
 * la empresa que se le pide (como el `WHERE distributor_id = $1`).
 */
function lecturaFalsa() {
  const deA = <T>(id: string | null, valor: T, vacio: T): T =>
    id === A ? valor : vacio;
  const conversaciones = [
    // Cliente: 10 min hábiles, a tiempo; cerrada a los 90 min.
    conversacion({
      conversationId: 'c-1',
      firstResponseAt: ar('2026-11-16T08:10'),
      closedAt: ar('2026-11-16T09:30'),
      closedReason: ConversationClosedReason.MANUAL,
    }),
    // Cliente: viernes 11:50 → lunes 8:50 = 60 hábiles, fuera del objetivo de 30.
    conversacion({
      conversationId: 'c-2',
      createdAt: ar('2026-11-13T11:50'),
      firstIncomingAt: ar('2026-11-13T11:50'),
      firstResponseAt: ar('2026-11-16T08:50'),
    }),
    // Chofer: sin respuesta desde el martes 10:00 (120 hábiles a las 12) → fuera.
    conversacion({
      conversationId: 'c-3',
      channel: Channel.STAFF_DRIVER,
      createdAt: ar('2026-11-17T10:00'),
      firstIncomingAt: ar('2026-11-17T10:00'),
    }),
    // Cliente: la resolvió el asistente y se cerró sin que nadie del equipo
    // escribiera (sin `first_response_at`): no es «sin respuesta» ni fuera
    // del objetivo; va aparte. Cerrada a los 20 minutos.
    conversacion({
      conversationId: 'c-4',
      createdAt: ar('2026-11-16T09:00'),
      firstIncomingAt: ar('2026-11-16T09:00'),
      closedAt: ar('2026-11-16T09:20'),
      closedReason: ConversationClosedReason.MANUAL,
    }),
    // Chofer: la abrió la empresa y nadie contestó: no hay espera; cerrada
    // porque el pedido pasó a otro chofer (no es una resolución).
    conversacion({
      conversationId: 'c-5',
      channel: Channel.STAFF_DRIVER,
      firstIncomingAt: null,
      closedAt: ar('2026-11-16T09:00'),
      closedReason: ConversationClosedReason.DRIVER_CHANGED,
    }),
  ];
  return {
    conversacionesDelPeriodo: jest.fn(
      (id: string, canales: readonly string[]) =>
        Promise.resolve(
          deA(
            id,
            conversaciones.filter((c) => canales.includes(c.channel)),
            [],
          ),
        ),
    ),
    // Etiquetas (7c): «Envíos» en las dos de clientes respondidas, «Choferes»
    // en la que espera y una de otro canal; «Pagos» sin conversaciones.
    etiquetasDelPeriodo: jest.fn((id: string) =>
      Promise.resolve(
        deA(
          id,
          [
            {
              labelId: 'e-1',
              name: 'Envíos',
              color: 'orange',
              conversationId: 'c-1',
            },
            {
              labelId: 'e-1',
              name: 'Envíos',
              color: 'orange',
              conversationId: 'c-2',
            },
            {
              labelId: 'e-2',
              name: 'Choferes',
              color: 'blue',
              conversationId: 'c-3',
            },
            {
              labelId: 'e-2',
              name: 'Choferes',
              color: 'blue',
              conversationId: 'otra',
            },
            {
              labelId: 'e-3',
              name: 'Pagos',
              color: 'green',
              conversationId: null,
            },
          ],
          [],
        ),
      ),
    ),
    enVivo: jest.fn((id: string, canales: readonly string[]) =>
      Promise.resolve(
        deA(
          id,
          [
            {
              channel: Channel.STAFF_CUSTOMER,
              open: 3,
              unassigned: 1,
              unanswered: 1,
              awaitingHuman: 1,
            },
            {
              channel: Channel.STAFF_DRIVER,
              open: 2,
              unassigned: 2,
              unanswered: 1,
              awaitingHuman: 0,
            },
          ].filter((f) => canales.includes(f.channel)),
          [],
        ),
      ),
    ),
    usoDePlantillas: jest.fn((id: string) =>
      Promise.resolve(
        deA(
          id,
          [
            { kind: 'quick' as const, key: 'saludo', count: 4 },
            { kind: 'auto' as const, key: 'fuera_de_horario', count: 2 },
            { kind: 'auto' as const, key: 'asistente_ia', count: 5 },
          ],
          [],
        ),
      ),
    ),
    trazasDelAsistente: jest.fn((_canal: string, _r: unknown, id: string) =>
      Promise.resolve({
        trazas: deA(
          id,
          [
            {
              distributorId: A,
              outcome: 'answered',
              reason: null,
              count: 5,
              conversations: 3,
            },
            {
              distributorId: A,
              outcome: 'handed_off',
              reason: 'requested',
              count: 1,
              conversations: 1,
            },
          ],
          [],
        ),
        atendidas: new Map(deA(id, [[A, 3] as [string, number]], [])),
      }),
    ),
    resueltasSinPersona: jest.fn(
      (_c: string, _p: string, _r: unknown, id: string) =>
        Promise.resolve(
          deA(
            id,
            [
              {
                distributorId: A,
                closedWithAssistant: 2,
                resolvedWithoutHuman: 1,
              },
            ],
            [],
          ),
        ),
    ),
    encuestas: jest.fn((id: string) =>
      Promise.resolve(
        deA<FilaDelResumen[]>(
          id,
          [
            { served_by: 'team', score: 5, n: '2', vencidas: '0' },
            { served_by: 'assistant', score: 3, n: '1', vencidas: '0' },
            { served_by: 'team', score: null, n: '1', vencidas: '1' },
          ],
          [],
        ),
      ),
    ),
  };
}

function servicio(asistenteDisponible = true) {
  const lectura = lecturaFalsa();
  const ajustes = {
    leer: jest.fn((id: string) =>
      Promise.resolve(
        Object.assign(ajustesDeLaBandejaPorDefecto(id), {
          businessHours: [1, 2, 3, 4, 5].map((weekday) => ({
            weekday,
            opensAt: '08:00',
            closesAt: '12:00',
          })),
          firstResponseTargetMinutes: 30,
          assistantAiEnabled: true,
        }),
      ),
    ),
    asistenteConIaDisponible: jest.fn((id: string) =>
      Promise.resolve(id.length > 0 && asistenteDisponible),
    ),
  };
  return {
    lectura,
    ajustes,
    s: new ChatMetricsService(
      lectura as unknown as MetricasReadModel,
      ajustes as unknown as CompanyChatSettingsService,
    ),
  };
}

describe('ChatMetricsService (métricas de la empresa)', () => {
  it('TPR hábil por canal y total, objetivo, resolución, en vivo, plantillas, asistente, encuesta y serie', async () => {
    const { s } = servicio();
    const m = await s.deLaEmpresa(
      A,
      { from: '2026-11-13', to: '2026-11-17' },
      AHORA,
    );
    expect(m.from).toBe('2026-11-13');
    expect(m.to).toBe('2026-11-17');
    expect(m.channel).toBeNull();
    expect(m.targetMinutes).toBe(30);
    expect(m.conversations).toBe(5);
    expect(m.firstResponse).toEqual({
      responded: 2,
      unanswered: 1,
      closedWithoutHumanReply: 1,
      medianMinutes: 35,
      p90Minutes: 60,
      target: { met: 1, missed: 2, rate: 0.333 },
    });
    expect(m.byChannel.map((c) => c.channel)).toEqual([
      Channel.STAFF_CUSTOMER,
      Channel.STAFF_DRIVER,
    ]);
    // Corte por etiqueta: conversaciones del período y su TPR (las de otro
    // canal o fuera del período no cuentan).
    expect(
      m.byLabel.map((e) => [
        e.label.name,
        e.conversations,
        e.firstResponse.responded,
        e.firstResponse.unanswered,
        e.firstResponse.medianMinutes,
      ]),
    ).toEqual([
      ['Envíos', 2, 2, 0, 35],
      ['Choferes', 1, 0, 1, null],
      ['Pagos', 0, 0, 0, null],
    ]);
    const [clientes, choferes] = m.byChannel;
    expect(clientes.firstResponse).toEqual({
      responded: 2,
      unanswered: 0,
      closedWithoutHumanReply: 1,
      medianMinutes: 35,
      p90Minutes: 60,
      target: { met: 1, missed: 1, rate: 0.5 },
    });
    expect(choferes.firstResponse).toEqual({
      responded: 0,
      unanswered: 1,
      closedWithoutHumanReply: 0,
      medianMinutes: null,
      p90Minutes: null,
      target: { met: 0, missed: 1, rate: 0 },
    });
    // La cerrada porque cambió el chofer no es una resolución.
    expect(m.resolution).toEqual({ closed: 2, medianMinutes: 55 });
    expect(choferes.resolution).toEqual({ closed: 0, medianMinutes: null });
    expect(m.live).toEqual({
      open: 5,
      unassigned: 3,
      unanswered: 2,
      awaitingHuman: 1,
    });
    expect(m.quickReplies).toEqual({
      total: 4,
      byKey: [{ key: 'saludo', count: 4 }],
    });
    expect(m.automaticReplies.total).toBe(7);
    expect(m.assistant).toEqual(
      expect.objectContaining({
        enabled: true,
        aiReplies: 5,
        handoffs: 1,
        conversationsAttended: 3,
        closedWithAssistant: 2,
        resolvedWithoutHuman: 1,
        resolvedWithoutHumanRate: 0.5,
      }),
    );
    expect(m.satisfaction).toEqual({
      requested: 4,
      answered: 3,
      expired: 1,
      responseRate: 0.75,
      average: 4.33,
      csat: 0.667,
      byScore: [
        { score: 1, count: 0 },
        { score: 2, count: 0 },
        { score: 3, count: 1 },
        { score: 4, count: 0 },
        { score: 5, count: 2 },
      ],
      assistant: { answered: 1, average: 3, csat: 0 },
      team: { answered: 2, average: 5, csat: 1 },
    });
    expect(m.daily).toEqual([
      {
        date: '2026-11-13',
        newConversations: 1,
        firstResponseMedianMinutes: 60,
      },
      {
        date: '2026-11-14',
        newConversations: 0,
        firstResponseMedianMinutes: null,
      },
      {
        date: '2026-11-15',
        newConversations: 0,
        firstResponseMedianMinutes: null,
      },
      {
        date: '2026-11-16',
        newConversations: 3,
        firstResponseMedianMinutes: 10,
      },
      {
        date: '2026-11-17',
        newConversations: 1,
        firstResponseMedianMinutes: null,
      },
    ]);
  });

  it('aislamiento: la empresa B no ve nada de A (todas las lecturas van con su id) y su tablero sale en ceros y null', async () => {
    const { s, lectura, ajustes } = servicio();
    const m = await s.deLaEmpresa(B, {}, AHORA);
    const primeros = [
      lectura.conversacionesDelPeriodo.mock.calls,
      lectura.enVivo.mock.calls,
      lectura.usoDePlantillas.mock.calls,
      lectura.encuestas.mock.calls,
      ajustes.leer.mock.calls,
      lectura.etiquetasDelPeriodo.mock.calls,
    ].map((llamadas) => llamadas.map((c: unknown[]) => c[0]));
    expect(primeros).toEqual([[B], [B], [B], [B], [B], [B]]);
    expect(m.byLabel).toEqual([]);
    expect(ajustes.asistenteConIaDisponible).toHaveBeenCalledWith(B);
    expect(lectura.trazasDelAsistente.mock.calls.every((c) => c[2] === B)).toBe(
      true,
    );
    expect(
      lectura.resueltasSinPersona.mock.calls.every((c) => c[3] === B),
    ).toBe(true);
    expect(m.conversations).toBe(0);
    expect(m.firstResponse).toEqual({
      responded: 0,
      unanswered: 0,
      closedWithoutHumanReply: 0,
      medianMinutes: null,
      p90Minutes: null,
      target: { met: 0, missed: 0, rate: null },
    });
    expect(m.live).toEqual({
      open: 0,
      unassigned: 0,
      unanswered: 0,
      awaitingHuman: 0,
    });
    expect(m.assistant).toEqual(
      expect.objectContaining({
        aiReplies: 0,
        handoffs: 0,
        handoffReasons: [],
        resolvedWithoutHumanRate: null,
      }),
    );
    expect(m.satisfaction).toEqual(
      expect.objectContaining({
        requested: 0,
        responseRate: null,
        average: null,
        csat: null,
      }),
    );
    expect(m.daily).toHaveLength(30);
    expect(
      m.daily.every(
        (d) =>
          d.newConversations === 0 && d.firstResponseMedianMinutes === null,
      ),
    ).toBe(true);
    expect(JSON.stringify(m)).not.toContain('NaN');
  });

  it('sólo choferes: sin asistente ni encuesta (no consulta lo de los clientes)', async () => {
    const { s, lectura, ajustes } = servicio();
    const m = await s.deLaEmpresa(
      A,
      { from: '2026-11-13', to: '2026-11-17', channel: Channel.STAFF_DRIVER },
      AHORA,
    );
    expect(m.channel).toBe(Channel.STAFF_DRIVER);
    expect(m.byChannel.map((c) => c.channel)).toEqual([Channel.STAFF_DRIVER]);
    expect(m.conversations).toBe(2);
    expect(m.assistant).toBeNull();
    expect(m.satisfaction).toBeNull();
    expect(lectura.conversacionesDelPeriodo).toHaveBeenCalledWith(
      A,
      [Channel.STAFF_DRIVER],
      expect.anything(),
    );
    expect(lectura.trazasDelAsistente).not.toHaveBeenCalled();
    expect(lectura.encuestas).not.toHaveBeenCalled();
    expect(ajustes.asistenteConIaDisponible).not.toHaveBeenCalled();
  });

  it('sin el asistente disponible para la empresa: `assistant` nulo', async () => {
    const { s, lectura } = servicio(false);
    const m = await s.deLaEmpresa(A, {}, AHORA);
    expect(m.assistant).toBeNull();
    expect(lectura.trazasDelAsistente).not.toHaveBeenCalled();
  });

  it('período inválido o de más de un año: 400 antes de leer nada', async () => {
    const { s, lectura } = servicio();
    await expect(
      s.deLaEmpresa(A, { from: '2025-01-01', to: '2026-11-16' }, AHORA),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      s.deLaEmpresa(A, { from: '2026-11-16', to: '2026-11-01' }, AHORA),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(lectura.conversacionesDelPeriodo).not.toHaveBeenCalled();
  });

  it('pasa el período como instantes argentinos `[desde, hasta)`', async () => {
    const { s, lectura } = servicio();
    await s.deLaEmpresa(A, { from: '2026-11-01', to: '2026-11-16' }, AHORA);
    expect(lectura.conversacionesDelPeriodo).toHaveBeenCalledWith(
      A,
      [Channel.STAFF_CUSTOMER, Channel.STAFF_DRIVER],
      {
        desde: new Date('2026-11-01T03:00:00.000Z'),
        hasta: new Date('2026-11-17T03:00:00.000Z'),
      },
    );
  });
});
