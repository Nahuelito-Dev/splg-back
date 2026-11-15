import type { ConfigService } from '@nestjs/config';
import {
  MessageKind,
  Party,
  TicketPriority,
  TicketStatus,
} from '../domain/chat.enums';
import type { Message } from '../entities/message.entity';
import type { SupportTicket } from '../entities/support-ticket.entity';
import type { ChatReadModel } from '../infrastructure/chat-read-model';
import { ChatMapper } from '../presentation/chat.mapper';
import { ChatViewsService } from './chat-views.service';

const ticket = {
  ticketId: 't1',
  distributorId: 'dist-a',
  conversationId: 'hilo-1',
  number: 12,
  subject: 'Factura duplicada',
  status: TicketStatus.WAITING_COMPANY,
  priority: TicketPriority.NORMAL,
  updatedAt: new Date('2026-11-14T10:00:00Z'),
  createdAt: new Date('2026-11-14T09:00:00Z'),
  firstResponseDueAt: null,
  firstResponseAt: null,
  resolvedAt: null,
  closedAt: null,
  assignedMemberUserId: null,
  originConversationId: null,
} as unknown as SupportTicket;

const ultimo = {
  messageId: 'm9',
  conversationId: 'hilo-1',
  seq: 9,
  senderParty: Party.PLATFORM,
  senderUserId: null,
  kind: MessageKind.TEXT,
  body: 'Ya está corregida',
  redactedAt: null,
  createdAt: new Date('2026-11-14T11:00:00Z'),
} as unknown as Message;

describe('resumen de ticket con no leídos y último mensaje (relevamiento B3)', () => {
  it('una lista de tickets trae los no leídos y el último mensaje de cada hilo', async () => {
    const vacio = () => Promise.resolve(new Map());
    const lectura = {
      noLeidos: (ids: string[]) =>
        Promise.resolve(new Map(ids.includes('hilo-1') ? [['hilo-1', 2]] : [])),
      ultimosVisibles: (ids: string[]) =>
        Promise.resolve(
          new Map(ids.includes('hilo-1') ? [['hilo-1', ultimo]] : []),
        ),
      lecturaDeLaOtraParte: vacio,
      lecturaPropia: vacio,
      citadosEn: vacio,
      ticketsDesde: vacio,
      ticketsDeLosHilos: vacio,
      nombres: vacio,
      empresas: vacio,
      sesionesDeSoporte: vacio,
    } as unknown as ChatReadModel;
    const vistas = new ChatViewsService(lectura, {
      get: () => undefined,
    } as unknown as ConfigService);
    const ctx = await vistas.contexto(
      { party: Party.COMPANY, userId: 'a' },
      { tickets: [ticket] },
    );
    expect(ChatMapper.ticketResumen(ticket, ctx)).toMatchObject({
      number: 'T-000012',
      unreadCount: 2,
      lastMessage: {
        seq: 9,
        preview: 'Ya está corregida',
        party: Party.PLATFORM,
        at: '2026-11-14T11:00:00.000Z',
      },
    }); // Cerrado: no marca novedades aunque haya algo sin leer.
    expect(
      ChatMapper.ticketResumen(
        { ...ticket, status: TicketStatus.CLOSED } as typeof ticket,
        ctx,
      ).unreadCount,
    ).toBe(0);
  });

  it('la ficha del ticket trae el «leído» de la otra punta y el propio, del hilo del ticket', async () => {
    const vacio = () => Promise.resolve(new Map());
    const pedidos: Array<{ ids: string[]; quien: string }> = [];
    const lectura = {
      noLeidos: vacio,
      ultimosVisibles: vacio,
      lecturaDeLaOtraParte: (ids: string[], otra: string) => {
        pedidos.push({ ids, quien: otra });
        return Promise.resolve(
          new Map(ids.includes('hilo-1') ? [['hilo-1', 7]] : []),
        );
      },
      lecturaPropia: (ids: string[], userId: string) =>
        Promise.resolve(
          new Map(
            ids.includes('hilo-1') && userId === 'a' ? [['hilo-1', 4]] : [],
          ),
        ),
      citadosEn: vacio,
      ticketsDesde: vacio,
      ticketsDeLosHilos: vacio,
      nombres: vacio,
      empresas: vacio,
      sesionesDeSoporte: vacio,
    } as unknown as ChatReadModel;
    const vistas = new ChatViewsService(lectura, {
      get: () => undefined,
    } as unknown as ConfigService);
    const ctx = await vistas.contexto(
      { party: Party.COMPANY, userId: 'a' },
      { tickets: [ticket] },
    );
    expect(ChatMapper.ticket(ticket, ctx)).toMatchObject({
      counterpartLastReadSeq: 7,
      lastReadSeq: 4,
    });
    // Para la empresa, la otra punta es la plataforma.
    expect(pedidos).toContainEqual({ ids: ['hilo-1'], quien: Party.PLATFORM });
  });

  it('sin lecturas registradas, los dos «leído» quedan en 0', async () => {
    const vacio = () => Promise.resolve(new Map());
    const lectura = {
      noLeidos: vacio,
      ultimosVisibles: vacio,
      lecturaDeLaOtraParte: vacio,
      lecturaPropia: vacio,
      citadosEn: vacio,
      ticketsDesde: vacio,
      ticketsDeLosHilos: vacio,
      nombres: vacio,
      empresas: vacio,
      sesionesDeSoporte: vacio,
    } as unknown as ChatReadModel;
    const vistas = new ChatViewsService(lectura, {
      get: () => undefined,
    } as unknown as ConfigService);
    const ctx = await vistas.contexto(
      { party: Party.PLATFORM, userId: 's' },
      { tickets: [ticket] },
    );
    expect(ChatMapper.ticket(ticket, ctx)).toMatchObject({
      counterpartLastReadSeq: 0,
      lastReadSeq: 0,
    });
  });
});
