import { Injectable } from '@nestjs/common';
import { ChatViewsService } from '../application/chat-views.service';
import { Party } from '../domain/chat.enums';
import type { Conversation } from '../entities/conversation.entity';
import type { Message } from '../entities/message.entity';
import type { SupportTicket } from '../entities/support-ticket.entity';
import type { Observador } from '../infrastructure/chat-read-model';
import { ChatMapper } from './chat.mapper';
import type {
  ConversationDto,
  MessageDto,
  TicketDto,
  TicketSummaryDto,
} from './dto/chat-response.dto';

export const comoEmpresa = (userId: string): Observador => ({
  party: Party.COMPANY,
  userId,
});

export const comoPlataforma = (userId: string): Observador => ({
  party: Party.PLATFORM,
  userId,
});

/** Arma las respuestas de los controllers para quien mira (una tanda de consultas por respuesta). */
@Injectable()
export class ChatPresenter {
  constructor(private readonly vistas: ChatViewsService) {}

  async conversaciones(
    conversaciones: readonly Conversation[],
    quien: Observador,
  ): Promise<ConversationDto[]> {
    const ctx = await this.vistas.contexto(quien, { conversaciones });
    return conversaciones.map((c) => ChatMapper.conversacion(c, ctx));
  }

  async conversacion(
    conversacion: Conversation,
    quien: Observador,
  ): Promise<ConversationDto> {
    const [dto] = await this.conversaciones([conversacion], quien);
    return dto;
  }

  async mensajes(
    mensajes: readonly Message[],
    quien: Observador,
  ): Promise<MessageDto[]> {
    const ctx = await this.vistas.contexto(quien, { mensajes });
    return mensajes.map((m) => ChatMapper.mensaje(m, ctx));
  }

  async mensaje(mensaje: Message, quien: Observador): Promise<MessageDto> {
    const [dto] = await this.mensajes([mensaje], quien);
    return dto;
  }

  async tickets(
    tickets: readonly SupportTicket[],
    quien: Observador,
  ): Promise<TicketDto[]> {
    const ctx = await this.vistas.contexto(quien, { tickets });
    return tickets.map((t) => ChatMapper.ticket(t, ctx));
  }

  async resumenes(
    tickets: readonly SupportTicket[],
    quien: Observador,
  ): Promise<TicketSummaryDto[]> {
    const ctx = await this.vistas.contexto(quien, { tickets });
    return tickets.map((t) => ChatMapper.ticketResumen(t, ctx));
  }

  async ticket(ticket: SupportTicket, quien: Observador): Promise<TicketDto> {
    const [dto] = await this.tickets([ticket], quien);
    return dto;
  }
}
