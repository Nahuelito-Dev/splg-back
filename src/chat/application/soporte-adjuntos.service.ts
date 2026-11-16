import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { DownloadLinkResponseDto } from '../../s3/dto/download-link.dto';
import { Channel, Party } from '../domain/chat.enums';
import { TicketNoEncontradoError } from '../domain/chat.errors';
import { assertAbierto } from '../domain/support-ticket.machine';
import type { Conversation } from '../entities/conversation.entity';
import { SupportTicket } from '../entities/support-ticket.entity';
import type { SendAttachmentDto } from '../presentation/dto/chat-attachment.dto';
import { AdjuntoEscrito, AdjuntosDelChat } from './adjuntos-del-chat.service';
import { ChatNotices } from './chat-notices';
import { ChatThreadsService } from './chat-threads.service';
import { MessageWriter } from './message-writer';
import { primeraRespuestaDeLaPlataforma } from './platform-chat.service';
import { TicketActivityService } from './ticket-activity.service';
import { ActorDeTicket, bloquearTicket, esPlataforma } from './ticket-store';

/**
 * Adjuntos en C1 (D-C27): el chat en vivo con la plataforma y el hilo de cada
 * ticket, desde las dos puntas. Se escribe en una conversación puntual (la
 * del chat abierto o la del ticket): cerrada → 409; de otra empresa → 404. En
 * el ticket, el adjunto es una respuesta (mueve el estado como el texto). Un
 * adjunto nunca es una nota interna (el endpoint no la ofrece y la base lo
 * rechaza, `CHK_message_visibilidad`).
 */
@Injectable()
export class SoporteAdjuntos {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly hilos: ChatThreadsService,
    private readonly writer: MessageWriter,
    private readonly tickets: TicketActivityService,
    private readonly avisos: ChatNotices,
    private readonly adjuntos: AdjuntosDelChat,
  ) {}

  /** La empresa sube al chat con la plataforma (el suyo, por id). */
  async alChatComoEmpresa(
    distributorId: string,
    userId: string,
    chatId: string,
    archivo: Express.Multer.File | undefined,
    dto: SendAttachmentDto,
  ): Promise<AdjuntoEscrito> {
    const c = await this.chat(chatId, distributorId);
    return this.adjuntos.subir(
      {
        conversation: c,
        party: Party.COMPANY,
        userId,
        archivo,
        dto,
        cupo: { ambito: distributorId },
      },
      async (manager, nuevo, efectos) => {
        const r = await this.writer.escribir(manager, nuevo);
        if (r.created) efectos.mensaje(r.conversation, r.message);
        return r;
      },
    );
  }

  /** La plataforma sube al chat de una empresa. */
  async alChatComoPlataforma(
    userId: string,
    chatId: string,
    archivo: Express.Multer.File | undefined,
    dto: SendAttachmentDto,
  ): Promise<AdjuntoEscrito> {
    const c = await this.chat(chatId, null);
    return this.adjuntos.subir(
      {
        conversation: c,
        party: Party.PLATFORM,
        userId,
        archivo,
        dto,
        cupo: { ambito: `chat:${chatId}` },
      },
      async (manager, nuevo, efectos) => {
        const r = await this.writer.escribir(manager, nuevo);
        if (!r.created) return r;
        efectos.mensaje(r.conversation, r.message);
        await primeraRespuestaDeLaPlataforma(manager, r.conversation);
        return r;
      },
    );
  }

  /** Cualquiera de las dos puntas sube al hilo de un ticket abierto (cerrado → 409 `TICKET_CLOSED`). */
  async alTicket(
    actor: ActorDeTicket,
    ticketId: string,
    archivo: Express.Multer.File | undefined,
    dto: SendAttachmentDto,
  ): Promise<AdjuntoEscrito & { ticket: SupportTicket }> {
    const { ticket, conversation } = await this.hiloDelTicket(actor, ticketId);
    assertAbierto(ticket.status);
    let actualizado = ticket;
    const r = await this.adjuntos.subir(
      {
        conversation,
        party: actor.party,
        userId: actor.userId,
        archivo,
        dto,
        cupo: { ambito: actor.distributorId ?? `ticket:${ticketId}` },
      },
      async (manager, nuevo, efectos) => {
        // El ticket antes que su hilo, como al responder con texto.
        const t = await bloquearTicket(manager, ticketId, actor.distributorId);
        assertAbierto(t.status);
        const escrito = await this.writer.escribir(manager, nuevo);
        if (!escrito.created) return escrito;
        efectos.mensaje(escrito.conversation, escrito.message);
        actualizado = await this.tickets.alResponder(
          manager,
          actor,
          t,
          escrito,
          efectos,
        );
        return escrito;
      },
    );
    if (r.created && esPlataforma(actor)) {
      this.avisos.respuestaDeLaPlataforma(actualizado, r.message.messageId);
    }
    return { ...r, ticket: actualizado };
  }

  /** URL del adjunto de un mensaje del chat (la empresa, el suyo; la plataforma, cualquiera). */
  async enlaceDelChat(
    party: Party.COMPANY | Party.PLATFORM,
    distributorId: string | null,
    chatId: string,
    messageId: string,
  ): Promise<DownloadLinkResponseDto> {
    const c = await this.chat(chatId, distributorId);
    return this.adjuntos.enlace(c, messageId, { party });
  }

  /** URL del adjunto de un mensaje del hilo de un ticket. */
  async enlaceDelTicket(
    actor: ActorDeTicket,
    ticketId: string,
    messageId: string,
  ): Promise<DownloadLinkResponseDto> {
    const { conversation } = await this.hiloDelTicket(actor, ticketId);
    return this.adjuntos.enlace(conversation, messageId, {
      party: actor.party,
    });
  }

  private chat(
    chatId: string,
    distributorId: string | null,
  ): Promise<Conversation> {
    return this.hilos.buscar({
      conversationId: chatId,
      channel: Channel.PLATFORM_CHAT,
      distributorId,
    });
  }

  private async hiloDelTicket(
    actor: ActorDeTicket,
    ticketId: string,
  ): Promise<{ ticket: SupportTicket; conversation: Conversation }> {
    const ticket = await this.dataSource.getRepository(SupportTicket).findOne({
      where: actor.distributorId
        ? { ticketId, distributorId: actor.distributorId }
        : { ticketId },
    });
    if (!ticket) throw new TicketNoEncontradoError();
    const conversation = await this.hilos.buscar({
      conversationId: ticket.conversationId,
      channel: Channel.PLATFORM_TICKET,
      distributorId: ticket.distributorId,
    });
    return { ticket, conversation };
  }
}
