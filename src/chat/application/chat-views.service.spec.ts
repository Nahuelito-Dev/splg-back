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
} as SupportTicket;

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
    });
  });
});
