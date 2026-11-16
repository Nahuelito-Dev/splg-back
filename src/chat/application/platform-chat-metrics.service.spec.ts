import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  Channel,
  ConversationStatus,
  Party,
  TicketStatus,
} from '../domain/chat.enums';
import type {
  MetricasReadModel,
  TicketDelPeriodo,
} from '../infrastructure/metricas-read-model';
import { PlatformChatMetricsService } from './platform-chat-metrics.service';
import {
  configuracionPorDefecto,
  type SupportSettingsService,
} from './support-settings.service';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ar = (diaYHora: string) => new Date(`${diaYHora}:00-03:00`);
const AHORA = ar('2026-11-17T12:00');

const ticket = (t: Partial<TicketDelPeriodo>): TicketDelPeriodo => ({
  openedByParty: Party.COMPANY,
  status: TicketStatus.OPEN,
  createdAt: ar('2026-11-16T09:00'),
  firstResponseAt: null,
  firstResponseDueAt: null,
  resolvedAt: null,
  satisfaction: null,
  ...t,
});

function lecturaFalsa() {
  return {
    existeLaEmpresa: jest.fn((id: string) => Promise.resolve(id === A)),
    chatsDeSoporte: jest.fn(() =>
      Promise.resolve([
        // 15 hábiles; terminó en ticket.
        {
          status: ConversationStatus.OPEN,
          createdAt: ar('2026-11-16T09:00'),
          firstCompanyAt: ar('2026-11-16T09:00'),
          firstReplyAt: ar('2026-11-16T09:15'),
          hasTicket: true,
        },
        // Viernes 11:50 → lunes 8:35 (horario 8 a 12): 45 hábiles.
        {
          status: ConversationStatus.OPEN,
          createdAt: ar('2026-11-13T11:50'),
          firstCompanyAt: ar('2026-11-13T11:50'),
          firstReplyAt: ar('2026-11-16T08:35'),
          hasTicket: false,
        },
        // Sin respuesta todavía.
        {
          status: ConversationStatus.OPEN,
          createdAt: ar('2026-11-17T11:00'),
          firstCompanyAt: ar('2026-11-17T11:00'),
          firstReplyAt: null,
          hasTicket: false,
        },
        // Cerrado sin respuesta de la plataforma (lo resolvió el asistente):
        // va aparte, no es «sin respuesta».
        {
          status: ConversationStatus.CLOSED,
          createdAt: ar('2026-11-16T11:00'),
          firstCompanyAt: ar('2026-11-16T11:00'),
          firstReplyAt: null,
          hasTicket: false,
        },
        // Lo abrió la plataforma y la empresa nunca escribió: sin espera.
        {
          status: ConversationStatus.OPEN,
          createdAt: ar('2026-11-16T10:00'),
          firstCompanyAt: null,
          firstReplyAt: null,
          hasTicket: false,
        },
      ]),
    ),
    // Esperan desde las 11:00 (60 hábiles) y desde las 11:40 (20).
    chatsEsperando: jest.fn(() =>
      Promise.resolve([ar('2026-11-17T11:00'), ar('2026-11-17T11:40')]),
    ),
    ticketsEnVivo: jest.fn(() => Promise.resolve({ open: 4, overdue: 1 })),
    ticketsDelPeriodo: jest.fn(() =>
      Promise.resolve([
        // A tiempo: respondido a los 30 hábiles, vencía a la hora.
        ticket({
          firstResponseAt: ar('2026-11-16T09:30'),
          firstResponseDueAt: ar('2026-11-16T10:00'),
          resolvedAt: ar('2026-11-16T11:00'),
          status: TicketStatus.CLOSED,
          satisfaction: 5,
        }),
        // Fuera de término: respondido después del vencimiento.
        ticket({
          firstResponseAt: ar('2026-11-16T11:00'),
          firstResponseDueAt: ar('2026-11-16T10:00'),
          resolvedAt: ar('2026-11-16T13:00'),
          status: TicketStatus.CLOSED,
        }),
        // Vencido sin responder.
        ticket({ firstResponseDueAt: ar('2026-11-17T09:00') }),
        // Resuelto sin escribir y con el plazo vencido: no cuenta fuera de
        // término ni como sin respuesta; tampoco en el denominador de la
        // encuesta (no está cerrado).
        ticket({
          firstResponseDueAt: ar('2026-11-16T10:00'),
          resolvedAt: ar('2026-11-16T12:00'),
          status: TicketStatus.RESOLVED,
        }),
        // Abierto desde un chat ya respondido: la respuesta es anterior a la
        // apertura; no se mide ni cuenta para el vencimiento.
        ticket({
          firstResponseAt: ar('2026-11-16T08:59'),
          firstResponseDueAt: ar('2026-11-16T10:00'),
        }),
        // Lo abrió la plataforma: no entra en la primera respuesta.
        ticket({
          openedByParty: Party.PLATFORM,
          firstResponseAt: ar('2026-11-16T09:00'),
          firstResponseDueAt: ar('2026-11-16T08:00'),
        }),
      ]),
    ),
    trazasDelAsistente: jest.fn((canal: Channel) =>
      Promise.resolve(
        canal === Channel.PLATFORM_CHAT
          ? {
              trazas: [
                {
                  distributorId: A,
                  outcome: 'answered',
                  reason: null,
                  count: 2,
                  conversations: 2,
                },
                {
                  distributorId: B,
                  outcome: 'handed_off',
                  reason: 'timeout',
                  count: 1,
                  conversations: 1,
                },
              ],
              atendidas: new Map([
                [A, 2],
                [B, 1],
              ]),
            }
          : {
              trazas: [
                {
                  distributorId: A,
                  outcome: 'answered',
                  reason: null,
                  count: 7,
                  conversations: 4,
                },
              ],
              atendidas: new Map([[A, 4]]),
            },
      ),
    ),
    resueltasSinPersona: jest.fn((canal: Channel) =>
      Promise.resolve(
        canal === Channel.PLATFORM_CHAT
          ? [
              {
                distributorId: A,
                closedWithAssistant: 1,
                resolvedWithoutHuman: 1,
              },
              {
                distributorId: B,
                closedWithAssistant: 1,
                resolvedWithoutHuman: 0,
              },
            ]
          : [
              {
                distributorId: A,
                closedWithAssistant: 4,
                resolvedWithoutHuman: 3,
              },
            ],
      ),
    ),
    usoPorEmpresa: jest.fn(() =>
      Promise.resolve([
        {
          distributorId: A,
          name: 'Gas del Sur',
          conversations: 10,
          messages: 80,
        },
        {
          distributorId: B,
          name: 'Florchi Gas',
          conversations: 2,
          messages: 5,
        },
      ]),
    ),
  };
}

function servicio() {
  const lectura = lecturaFalsa();
  const soporte = {
    leer: jest.fn(() =>
      Promise.resolve(
        Object.assign(configuracionPorDefecto(), {
          timezone: 'America/Argentina/Buenos_Aires',
          chatHours: [1, 2, 3, 4, 5].map((weekday) => ({
            weekday,
            opensAt: '08:00',
            closesAt: '12:00',
          })),
        }),
      ),
    ),
  };
  return {
    lectura,
    s: new PlatformChatMetricsService(
      lectura as unknown as MetricasReadModel,
      soporte as unknown as SupportSettingsService,
    ),
  };
}

describe('PlatformChatMetricsService (tablero de la plataforma)', () => {
  it('chat: esperando, TPR hábil sin objetivo y % que terminó en ticket', async () => {
    const { s } = servicio();
    const m = await s.metricas({ from: '2026-11-13', to: '2026-11-17' }, AHORA);
    expect(m.distributorId).toBeNull();
    expect(m.chat).toEqual({
      chats: 5,
      waiting: 2,
      longestWaitMinutes: 60,
      medianWaitMinutes: 40,
      firstResponse: {
        responded: 2,
        unanswered: 1,
        closedWithoutHumanReply: 1,
        medianMinutes: 30,
        p90Minutes: 45,
        target: null,
      },
      endedInTicket: 1,
      endedInTicketRate: 0.2,
    });
  });

  it('tickets: sólo los de la empresa en la primera respuesta, vencimiento, resolución y satisfacción', async () => {
    const { s } = servicio();
    const m = await s.metricas({ from: '2026-11-13', to: '2026-11-17' }, AHORA);
    expect(m.tickets).toEqual({
      created: 6,
      open: 4,
      overdue: 1,
      firstResponse: {
        responded: 2,
        unanswered: 1,
        closedWithoutHumanReply: 1,
        medianMinutes: 75,
        p90Minutes: 120,
        target: { met: 1, missed: 2, rate: 0.333 },
      },
      resolution: { resolved: 3, medianMinutes: 180 },
      satisfaction: {
        rated: 1,
        responseRate: 0.5,
        average: 5,
        byScore: [
          { score: 1, count: 0 },
          { score: 2, count: 0 },
          { score: 3, count: 0 },
          { score: 4, count: 0 },
          { score: 5, count: 1 },
        ],
      },
    });
  });

  it('asistente del soporte y, por empresa, sólo conteos y su asistente si lo usó', async () => {
    const { s } = servicio();
    const m = await s.metricas({}, AHORA);
    expect(m.assistant).toEqual({
      aiReplies: 2,
      handoffs: 1,
      handoffReasons: [
        {
          reason: 'timeout',
          label: 'El asistente tardó demasiado en responder',
          count: 1,
        },
      ],
      conversationsAttended: 3,
      closedWithAssistant: 2,
      resolvedWithoutHuman: 1,
      resolvedWithoutHumanRate: 0.5,
    });
    expect(m.companies).toEqual([
      {
        distributorId: A,
        name: 'Gas del Sur',
        conversations: 10,
        messages: 80,
        assistant: {
          aiReplies: 7,
          handoffs: 0,
          handoffReasons: [],
          conversationsAttended: 4,
          closedWithAssistant: 4,
          resolvedWithoutHuman: 3,
          resolvedWithoutHumanRate: 0.75,
        },
      },
      {
        distributorId: B,
        name: 'Florchi Gas',
        conversations: 2,
        messages: 5,
        assistant: null,
      },
    ]);
    // Nada de texto: sólo números, fechas del período, ids y nombres.
    expect(JSON.stringify(m)).not.toMatch(/body|preview|comment/);
  });

  it('con `distributorId`: todas las lecturas van filtradas por esa empresa', async () => {
    const { s, lectura } = servicio();
    const m = await s.metricas({ distributorId: A }, AHORA);
    expect(m.distributorId).toBe(A);
    expect(lectura.chatsDeSoporte).toHaveBeenCalledWith(expect.anything(), A);
    expect(lectura.chatsEsperando).toHaveBeenCalledWith(A);
    expect(lectura.ticketsEnVivo).toHaveBeenCalledWith(AHORA, A);
    expect(lectura.ticketsDelPeriodo).toHaveBeenCalledWith(
      expect.anything(),
      A,
    );
    expect(lectura.usoPorEmpresa).toHaveBeenCalledWith(expect.anything(), A);
    expect(
      lectura.trazasDelAsistente.mock.calls.map((c) => (c as unknown[])[2]),
    ).toEqual([A, A]);
    expect(
      lectura.resueltasSinPersona.mock.calls.map((c) => (c as unknown[])[3]),
    ).toEqual([A, A]);
  });

  it('empresa que no existe: 404; período inválido: 400; sin lecturas', async () => {
    const { s, lectura } = servicio();
    await expect(
      s.metricas({ distributorId: B }, AHORA),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      s.metricas({ from: '2024-01-01', to: '2026-11-16' }, AHORA),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(lectura.chatsDeSoporte).not.toHaveBeenCalled();
  });

  it('sin datos: ceros y null, nunca NaN', async () => {
    const { s, lectura } = servicio();
    for (const f of [
      lectura.chatsDeSoporte,
      lectura.chatsEsperando,
      lectura.ticketsDelPeriodo,
      lectura.usoPorEmpresa,
    ]) {
      f.mockResolvedValueOnce([]);
    }
    lectura.resueltasSinPersona.mockResolvedValue([]);
    lectura.trazasDelAsistente.mockResolvedValue({
      trazas: [],
      atendidas: new Map(),
    });
    lectura.ticketsEnVivo.mockResolvedValueOnce({ open: 0, overdue: 0 });
    const m = await s.metricas({}, AHORA);
    expect(m.chat).toEqual({
      chats: 0,
      waiting: 0,
      longestWaitMinutes: null,
      medianWaitMinutes: null,
      firstResponse: {
        responded: 0,
        unanswered: 0,
        closedWithoutHumanReply: 0,
        medianMinutes: null,
        p90Minutes: null,
        target: null,
      },
      endedInTicket: 0,
      endedInTicketRate: null,
    });
    expect(m.tickets.firstResponse.target).toEqual({
      met: 0,
      missed: 0,
      rate: null,
    });
    expect(m.tickets.satisfaction.responseRate).toBeNull();
    expect(m.tickets.satisfaction.average).toBeNull();
    expect(m.assistant.resolvedWithoutHumanRate).toBeNull();
    expect(m.companies).toEqual([]);
    expect(JSON.stringify(m)).not.toContain('NaN');
  });
});
