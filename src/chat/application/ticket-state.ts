import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  ConversationClosedReason,
  ConversationStatus,
  MessageKind,
  MessageVisibility,
  Party,
  SystemCode,
  TicketStatus,
} from '../domain/chat.enums';
import {
  assertTransicion,
  numeroDeTicket,
} from '../domain/support-ticket.machine';
import { Conversation } from '../entities/conversation.entity';
import { SupportTicket } from '../entities/support-ticket.entity';
import { Efectos } from './chat.events';
import { MessageWriter } from './message-writer';

/**
 * El único camino para cambiar el estado de un ticket: valida la transición
 * con la máquina, fija las fechas, deja el mensaje de sistema en el hilo y,
 * al cerrarlo, cierra el hilo. No toca el chat del que salió (estados
 * independientes, §4.2.3).
 */
@Injectable()
export class TicketState {
  constructor(private readonly writer: MessageWriter) {}

  async cambiar(
    manager: EntityManager,
    ticket: SupportTicket,
    nuevo: TicketStatus,
    efectos: Efectos,
    ahora: Date = new Date(),
  ): Promise<void> {
    if (ticket.status === nuevo) return;
    assertTransicion(ticket.status, nuevo);
    const anterior = ticket.status;
    const r = await this.writer.escribir(manager, {
      conversationId: ticket.conversationId,
      distributorId: ticket.distributorId,
      senderParty: Party.SYSTEM,
      senderUserId: null,
      clientMessageId: null,
      kind: MessageKind.SYSTEM,
      visibility: MessageVisibility.ALL,
      body: null,
      payload: {
        ticketId: ticket.ticketId,
        number: numeroDeTicket(ticket.number),
        from: anterior,
        to: nuevo,
      },
      systemCode: SystemCode.TICKET_STATUS_CHANGED,
      templateKey: null,
    });
    efectos.mensaje(r.conversation, r.message);

    ticket.status = nuevo;
    ticket.statusChangedAt = ahora;
    if (nuevo === TicketStatus.RESOLVED) ticket.resolvedAt = ahora;
    if (nuevo === TicketStatus.CLOSED) {
      ticket.closedAt = ahora;
      const repo = manager.getRepository(Conversation);
      const hilo = await repo.findOneByOrFail({
        conversationId: ticket.conversationId,
      });
      hilo.status = ConversationStatus.CLOSED;
      hilo.closedAt = ahora;
      hilo.closedReason = ConversationClosedReason.TICKET_CLOSED;
      efectos.conversacion(await repo.save(hilo), 'closed');
    }
  }
}
