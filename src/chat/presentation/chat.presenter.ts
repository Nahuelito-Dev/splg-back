import { Injectable } from '@nestjs/common';
import { ChatViewsService } from '../application/chat-views.service';
import { Party } from '../domain/chat.enums';
import type { Conversation } from '../entities/conversation.entity';
import type { Message } from '../entities/message.entity';
import type { SupportTicket } from '../entities/support-ticket.entity';
import { ChatReadModel } from '../infrastructure/chat-read-model';
import type { Observador } from '../infrastructure/chat-read-model';
import { EntityPhotoService } from '../../s3/entity-photo.service';
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
  constructor(
    private readonly vistas: ChatViewsService,
    private readonly lectura: ChatReadModel,
    private readonly fotos: EntityPhotoService,
  ) {}

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
    const [ctx, logos] = await Promise.all([
      this.vistas.contexto(quien, { tickets }),
      this.logosDeLasEmpresas(tickets, quien),
    ]);
    return tickets.map((t) => ChatMapper.ticket(t, ctx, logos));
  }

  /**
   * El logo firmado de la empresa de cada ticket, sólo para la plataforma (la
   * empresa ya tiene el suyo): una consulta por los ids y una firma por empresa.
   */
  private async logosDeLasEmpresas(
    tickets: readonly SupportTicket[],
    quien: Observador,
  ): Promise<Map<string, string | null>> {
    if (quien.party !== Party.PLATFORM || tickets.length === 0) {
      return new Map();
    }
    const keys = await this.lectura.logosDeLasEmpresas(
      tickets.map((t) => t.distributorId),
    );
    const firmados = await Promise.all(
      [...keys].map(
        async ([id, key]) =>
          [id, await this.fotos.urlDe(key)] as [string, string | null],
      ),
    );
    return new Map(firmados);
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
