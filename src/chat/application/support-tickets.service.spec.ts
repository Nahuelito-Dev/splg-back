import { NotFoundException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import {
  Channel,
  ConversationStatus,
  MessageKind,
  MessageVisibility,
  Party,
  SystemCode,
  TicketCategory,
  TicketPriority,
  TicketStatus,
} from '../domain/chat.enums';
import { CitaInvalidaError, TicketCerradoError } from '../domain/chat.errors';
import { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';
import { SupportTicket } from '../entities/support-ticket.entity';
import type { ChatEvents } from './chat.events';
import type { ChatNotices } from './chat-notices';
import type { ChatRateLimit } from './chat-rate-limit';
import type { ConversationFactory } from './conversation-factory';
import type { NuevoMensaje } from './mensajes.port';
import type { MessageWriter } from './message-writer';
import {
  configuracionPorDefecto,
  type SupportSettingsService,
} from './support-settings.service';
import { SupportTicketsService } from './support-tickets.service';

const chatDeA = Object.assign(new Conversation(), {
  conversationId: 'chat-a',
  distributorId: 'dist-a',
  channel: Channel.PLATFORM_CHAT,
  status: ConversationStatus.OPEN,
  lastMessageSeq: 10,
});

const mensajesDelChat = Array.from({ length: 10 }, (_, i) =>
  Object.assign(new Message(), {
    messageId: `m${i + 1}`,
    seq: i + 1,
    senderParty: i % 2 ? Party.PLATFORM : Party.COMPANY,
    kind: MessageKind.TEXT,
    visibility: MessageVisibility.ALL,
    body: `texto ${i + 1}`,
    createdAt: new Date(Date.UTC(2026, 10, 14, 10, i + 1)),
    redactedAt: null,
  }),
);

describe('SupportTicketsService: tickets desde el chat y citas', () => {
  let escritos: NuevoMensaje[];
  let enlaces: unknown[];
  let ticketExistente: SupportTicket | null;
  let previo: SupportTicket | null;
  let service: SupportTicketsService;
  let avisos: { ticketDeLaEmpresa: jest.Mock; ticketDeLaPlataforma: jest.Mock };

  beforeEach(() => {
    escritos = [];
    enlaces = [];
    previo = null;
    ticketExistente = Object.assign(new SupportTicket(), {
      ticketId: 't1',
      distributorId: 'dist-a',
      conversationId: 'hilo-1',
      status: TicketStatus.OPEN,
      number: 9,
    });
    const qbMensajes = {
      where: () => qbMensajes,
      andWhere: (_c: string, p?: { desde?: number; hasta?: number }) => {
        if (p?.desde !== undefined) rango = [p.desde, p.hasta ?? 0];
        return qbMensajes;
      },
      orderBy: () => qbMensajes,
      getMany: () =>
        Promise.resolve(
          mensajesDelChat.filter((m) => m.seq >= rango[0] && m.seq <= rango[1]),
        ),
    };
    let rango: [number, number] = [0, 0];
    const qbTicket = {
      innerJoin: () => qbTicket,
      where: () => qbTicket,
      andWhere: () => qbTicket,
      getOne: () => Promise.resolve(previo),
    };
    const manager = {
      query: (sql: string) =>
        Promise.resolve(
          sql.includes('nextval') ? [{ n: '123' }] : [{ name: 'Gas Norte' }],
        ),
      createQueryBuilder: () => {
        const ins = {
          insert: () => ins,
          into: () => ins,
          values: (v: unknown[]) => (enlaces.push(...v), ins),
          orIgnore: () => ins,
          execute: () => Promise.resolve(),
        };
        return ins;
      },
      getRepository: (e: unknown) => {
        if (e === Conversation) {
          return {
            findOne: ({ where }: { where: { distributorId?: string } }) =>
              Promise.resolve(
                !where.distributorId || where.distributorId === 'dist-a'
                  ? chatDeA
                  : null,
              ),
          };
        }
        if (e === Message) return { createQueryBuilder: () => qbMensajes };
        return {
          findOne: ({ where }: { where: { distributorId?: string } }) =>
            Promise.resolve(
              !where.distributorId || where.distributorId === 'dist-a'
                ? ticketExistente
                : null,
            ),
          create: (x: Partial<SupportTicket>) =>
            Object.assign(new SupportTicket(), x),
          save: (x: SupportTicket) =>
            Promise.resolve(Object.assign(x, { ticketId: 'nuevo' })),
          createQueryBuilder: () => qbTicket,
        };
      },
    } as unknown as EntityManager;
    const writer = {
      escribir: (_m: EntityManager, n: NuevoMensaje) => {
        escritos.push(n);
        return Promise.resolve({
          created: true,
          conversation: chatDeA,
          message: { ...n, messageId: `w${escritos.length}` },
        });
      },
    } as unknown as MessageWriter;
    avisos = { ticketDeLaEmpresa: jest.fn(), ticketDeLaPlataforma: jest.fn() };
    service = new SupportTicketsService(
      {
        transaction: <T>(fn: (m: EntityManager) => Promise<T>) => fn(manager),
        manager,
      } as unknown as DataSource,
      writer,
      {
        crear: () =>
          Promise.resolve({
            conversationId: 'hilo-nuevo',
            distributorId: 'dist-a',
          }),
      } as unknown as ConversationFactory,
      {
        leer: () => Promise.resolve(configuracionPorDefecto()),
      } as unknown as SupportSettingsService,
      { ticket: () => Promise.resolve() } as unknown as ChatRateLimit,
      { publicar: jest.fn() } as unknown as ChatEvents,
      avisos as unknown as ChatNotices,
    );
  });

  const empresaA = {
    party: Party.COMPANY,
    userId: 'admin-a',
    distributorId: 'dist-a',
  } as const;
  const datos = {
    category: TicketCategory.BILLING,
    priority: TicketPriority.HIGH,
    subject: 'Factura de octubre duplicada',
  };

  it('desde el chat de A con los mensajes 3 a 7: cita de 5, enlaces y aviso en el chat', async () => {
    const t = await service.crearDesdeElChat(empresaA, 'chat-a', {
      ...datos,
      fromSeq: 3,
      toSeq: 7,
    });
    const cita = escritos.find((e) => e.kind === MessageKind.QUOTED_EXCERPT);
    expect(
      (cita?.payload as { items: Array<{ seq: number }> }).items.map(
        (i) => i.seq,
      ),
    ).toEqual([3, 4, 5, 6, 7]);
    expect(enlaces).toHaveLength(5);
    expect(escritos.at(-1)).toMatchObject({
      conversationId: 'chat-a',
      systemCode: SystemCode.TICKET_OPENED,
      payload: { number: 'T-000123', subject: datos.subject },
    });
    // Abierto por la empresa: nuevo, con la primera respuesta de la plataforma dentro de la cita.
    expect(t).toMatchObject({
      status: TicketStatus.NEW,
      originConversationId: 'chat-a',
      originFromSeq: 3,
      originToSeq: 7,
      firstResponseAt: mensajesDelChat[3].createdAt,
    });
    expect(avisos.ticketDeLaEmpresa).toHaveBeenCalledTimes(1);
  });

  it('el rango 3–900 es 400 TICKET_EXCERPT_INVALID y no crea nada', async () => {
    await expect(
      service.crearDesdeElChat(empresaA, 'chat-a', {
        ...datos,
        fromSeq: 3,
        toSeq: 900,
      }),
    ).rejects.toBeInstanceOf(CitaInvalidaError);
    expect(escritos).toHaveLength(0);
  });

  it('el chat de A desde la empresa B es 404', async () => {
    await expect(
      service.crearDesdeElChat(
        { party: Party.COMPANY, userId: 'admin-b', distributorId: 'dist-b' },
        'chat-a',
        { ...datos, fromSeq: 3, toSeq: 7 },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('citar en un ticket de B el chat de A es 404 (el chat tiene que ser de la empresa del ticket)', async () => {
    ticketExistente = Object.assign(new SupportTicket(), {
      ticketId: 't-b',
      distributorId: 'dist-b',
      conversationId: 'hilo-b',
      status: TicketStatus.OPEN,
    });
    await expect(
      service.agregarCita(
        { party: Party.PLATFORM, userId: 'super', distributorId: null },
        't-b',
        { sourceConversationId: 'chat-a', fromSeq: 1, toSeq: 2 },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(escritos).toHaveLength(0);
  });

  it('citar en un ticket cerrado es 409', async () => {
    ticketExistente!.status = TicketStatus.CLOSED;
    await expect(
      service.agregarCita(empresaA, 't1', {
        sourceConversationId: 'chat-a',
        fromSeq: 1,
        toSeq: 2,
      }),
    ).rejects.toBeInstanceOf(TicketCerradoError);
  });

  it('un ticket directo repetido (mismo primer clientMessageId) devuelve el mismo sin crear otro', async () => {
    previo = ticketExistente;
    const r = await service.crear(empresaA, {
      ...datos,
      distributorId: 'dist-a',
      firstMessage: { clientMessageId: 'c-1', body: 'Hola' },
    });
    expect(r).toEqual({ ticket: ticketExistente, created: false });
    expect(escritos).toHaveLength(0);
    expect(avisos.ticketDeLaEmpresa).not.toHaveBeenCalled();
  });

  it('un ticket que abre la plataforma queda esperando a la empresa y asignado a quien lo abre', async () => {
    const r = await service.crear(
      { party: Party.PLATFORM, userId: 'super', distributorId: null },
      {
        ...datos,
        distributorId: 'dist-a',
        firstMessage: { clientMessageId: 'c-2', body: 'Hola' },
      },
    );
    expect(r.ticket).toMatchObject({
      status: TicketStatus.WAITING_COMPANY,
      assignedMemberUserId: 'super',
      openedByParty: Party.PLATFORM,
    });
    expect(avisos.ticketDeLaPlataforma).toHaveBeenCalledTimes(1);
  });
});
