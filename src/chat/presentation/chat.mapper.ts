import type { ContextoDeVista } from '../application/chat-views.service';
import {
  Channel,
  ConversationStatus,
  MessageKind,
  Party,
  TicketStatus,
} from '../domain/chat.enums';
import { numeroDeTicket } from '../domain/support-ticket.machine';
import type { Conversation } from '../entities/conversation.entity';
import type { Message } from '../entities/message.entity';
import type { SupportTicket } from '../entities/support-ticket.entity';
import {
  ConversationDto,
  MessageDto,
  TicketDto,
  TicketSummaryDto,
} from './dto/chat-response.dto';

/** El nombre de pila de un nombre completo (D-C19: la empresa ve el de quien la atiende). */
export function nombreDePila(nombreCompleto: string): string {
  return nombreCompleto.trim().split(/\s+/)[0] || nombreCompleto;
}

const esPlataforma = (ctx: ContextoDeVista) =>
  ctx.observador.party === Party.PLATFORM;

/**
 * Conversaciones, mensajes y tickets tal como los ve quien pide (la empresa o
 * la plataforma). La empresa nunca recibe una nota interna ni quién la
 * atiende en la plataforma más allá del nombre de pila.
 */
export class ChatMapper {
  /** Resumen con lo que el panel necesita para marcar novedades: no leídos y último mensaje del hilo. */
  static ticketResumen(
    t: SupportTicket,
    ctx: ContextoDeVista,
  ): TicketSummaryDto {
    return {
      id: t.ticketId,
      number: numeroDeTicket(t.number),
      subject: t.subject,
      status: t.status,
      priority: t.priority,
      updatedAt: t.updatedAt.toISOString(),
      // Un ticket cerrado ya no pide atención: no marca novedades aunque quede algo sin leer.
      unreadCount:
        t.status === TicketStatus.CLOSED
          ? 0
          : (ctx.noLeidos.get(t.conversationId) ?? 0),
      lastMessage: ChatMapper.ultimoMensaje(ctx.ultimos.get(t.conversationId)),
    };
  }

  private static ultimoMensaje(
    m: Message | undefined,
  ): TicketSummaryDto['lastMessage'] {
    return m
      ? {
          seq: m.seq,
          preview: ChatMapper.vistaPrevia(m),
          at: m.createdAt.toISOString(),
          party: m.senderParty,
        }
      : null;
  }

  static ticket(t: SupportTicket, ctx: ContextoDeVista): TicketDto {
    const asignado = t.assignedMemberUserId
      ? (ctx.nombres.get(t.assignedMemberUserId) ?? 'Sin nombre')
      : null;
    const dto: TicketDto = {
      ...ChatMapper.ticketResumen(t, ctx),
      distributorId: t.distributorId,
      distributorName: ctx.empresas.get(t.distributorId) ?? '',
      category: t.category,
      conversationId: t.conversationId,
      origin:
        t.originConversationId &&
        t.originFromSeq !== null &&
        t.originToSeq !== null
          ? {
              conversationId: t.originConversationId,
              fromSeq: t.originFromSeq,
              toSeq: t.originToSeq,
            }
          : null,
      openedBy: t.openedByParty,
      firstResponseDueAt: t.firstResponseDueAt?.toISOString() ?? null,
      firstResponseAt: t.firstResponseAt?.toISOString() ?? null,
      resolvedAt: t.resolvedAt?.toISOString() ?? null,
      closedAt: t.closedAt?.toISOString() ?? null,
      satisfaction: t.satisfaction,
      supportSessions: ctx.sesiones.get(t.ticketId) ?? [],
      counterpartLastReadSeq:
        ctx.lecturaDeLaOtraParte.get(t.conversationId) ?? 0,
      lastReadSeq: ctx.lecturaPropia.get(t.conversationId) ?? 0,
      createdAt: t.createdAt.toISOString(),
    };
    if (esPlataforma(ctx)) {
      dto.assignedTo = t.assignedMemberUserId
        ? { userId: t.assignedMemberUserId, fullName: asignado ?? '' }
        : null;
    } else {
      dto.attendedBy = asignado
        ? { displayName: nombreDePila(asignado) }
        : null;
    }
    return dto;
  }

  static conversacion(c: Conversation, ctx: ContextoDeVista): ConversationDto {
    const ultimo = ctx.ultimos.get(c.conversationId);
    const ticket = ctx.ticketDelHilo.get(c.conversationId);
    const empresa = ctx.empresas.get(c.distributorId) ?? '';
    const dto: ConversationDto = {
      id: c.conversationId,
      distributorId: c.distributorId,
      distributorName: empresa,
      channel: c.channel,
      subjectType: c.subjectType,
      counterpart: esPlataforma(ctx)
        ? { party: Party.COMPANY, displayName: empresa, photoUrl: null }
        : {
            party: Party.PLATFORM,
            displayName: `Soporte ${ctx.plataforma}`,
            photoUrl: null,
          },
      status: c.status,
      canWrite:
        c.status === ConversationStatus.OPEN &&
        (ticket === undefined || ticket.status !== TicketStatus.CLOSED),
      lastMessage: ChatMapper.ultimoMensaje(ultimo),
      unreadCount: ctx.noLeidos.get(c.conversationId) ?? 0,
      counterpartLastReadSeq:
        ctx.lecturaDeLaOtraParte.get(c.conversationId) ?? 0,
      closedReason: c.closedReason,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
    if (c.channel === Channel.PLATFORM_CHAT) {
      const asignado = c.assignedToUserId
        ? (ctx.nombres.get(c.assignedToUserId) ?? 'Sin nombre')
        : null;
      if (esPlataforma(ctx)) {
        dto.assignedTo = c.assignedToUserId
          ? { userId: c.assignedToUserId, fullName: asignado ?? '' }
          : null;
      } else {
        dto.attendedBy = asignado
          ? { displayName: nombreDePila(asignado) }
          : null;
      }
      dto.ticketsFromHere = (ctx.ticketsDesde.get(c.conversationId) ?? []).map(
        (t) => ChatMapper.ticketResumen(t, ctx),
      );
    }
    if (ticket) dto.ticket = ChatMapper.ticket(ticket, ctx);
    return dto;
  }

  static mensaje(m: Message, ctx: ContextoDeVista): MessageDto {
    const mio = m.senderParty === ctx.observador.party;
    const redactado = m.redactedAt !== null;
    return {
      id: m.messageId,
      conversationId: m.conversationId,
      seq: m.seq,
      clientMessageId: mio ? m.clientMessageId : null,
      party: m.senderParty,
      sender: ChatMapper.autor(m, ctx),
      isMine: mio,
      kind: m.kind,
      payload: redactado ? null : (m.payload as Record<string, unknown> | null),
      citedInTickets: ctx.citados.get(m.messageId) ?? [],
      body: redactado ? null : m.body,
      bodyFiltered: m.bodyFiltered,
      templateKey: m.templateKey,
      systemCode: m.systemCode,
      visibility: m.visibility,
      redacted: redactado,
      createdAt: m.createdAt.toISOString(),
    };
  }

  /** La plataforma ve el nombre completo; la empresa, el de pila de quien la atiende y el completo de su gente. */
  private static autor(
    m: Message,
    ctx: ContextoDeVista,
  ): { displayName: string } | null {
    if (!m.senderUserId) return null;
    const nombre = ctx.nombres.get(m.senderUserId) ?? 'Sin nombre';
    const deLaPlataformaParaLaEmpresa =
      !esPlataforma(ctx) && m.senderParty === Party.PLATFORM;
    return {
      displayName: deLaPlataformaParaLaEmpresa ? nombreDePila(nombre) : nombre,
    };
  }

  private static vistaPrevia(m: Message): string | null {
    if (m.redactedAt !== null || m.body === null) return null;
    if (m.kind === MessageKind.SYSTEM || m.kind === MessageKind.QUOTED_EXCERPT)
      return null;
    const limpio = m.body.replace(/\s+/g, ' ').trim();
    return limpio.length <= 140 ? limpio : `${limpio.slice(0, 139)}…`;
  }
}
