import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { ConfiguracionDePlataforma } from '../../common/config/plataforma.config';
import { NOMBRE_DE_PLATAFORMA_POR_DEFECTO } from '../../common/config/plataforma.config';
import { pedirAvisoAlAdmin } from '../../common/events/aviso-al-admin';
import { errorMessage } from '../../common/errors/error-message';
import { escaparHtml } from '../../common/utils/html.util';
import { EmailSenderPort } from '../../email/ports/email-sender.port';
import { TicketPriority } from '../domain/chat.enums';
import { numeroDeTicket } from '../domain/support-ticket.machine';
import type { SupportTicket } from '../entities/support-ticket.entity';

/** Entidad del enlace del aviso: lleva a la ficha del ticket. */
export const ENLACE_DE_TICKET = 'support-ticket';

export const AVISO_TICKET_NUEVO = 'support_ticket_created';
export const AVISO_TICKET_RESPONDIDO = 'support_ticket_replied';
export const AVISO_TICKET_RESUELTO = 'support_ticket_resolved';
export const AVISO_TICKET_POR_CERRARSE = 'support_ticket_closing_soon';
export const AVISO_TICKET_SIN_RESPUESTA = 'support_ticket_response_overdue';

/**
 * Avisos de los tickets (diseño §8.1 y §8.2). A la empresa, en su bandeja y por
 * correo: cuando la plataforma le abre un ticket, le responde, lo resuelve o
 * está por cerrarse sin respuesta. A la plataforma, en su bandeja: ticket
 * nuevo de una empresa y objetivo de primera respuesta vencido; por correo a
 * la casilla de soporte, sólo los urgentes. El chat en vivo no manda correo.
 * Best-effort: el hecho ya ocurrió.
 */
@Injectable()
export class ChatNotices {
  private readonly logger = new Logger(ChatNotices.name);

  constructor(
    private readonly events: EventEmitter2,
    private readonly config: ConfigService,
    private readonly correo: EmailSenderPort,
  ) {}

  /** La empresa abrió un ticket: bandeja de la plataforma y, si es urgente, correo a soporte. */
  ticketDeLaEmpresa(ticket: SupportTicket, empresa: string): void {
    const numero = numeroDeTicket(ticket.number);
    pedirAvisoAlAdmin(this.events, this.logger, {
      distributorId: null,
      kind: AVISO_TICKET_NUEVO,
      title: `${empresa} abrió el ticket ${numero}`,
      body: ticket.subject,
      link: { entity: ENLACE_DE_TICKET, id: ticket.ticketId },
      dedupeKey: `${ENLACE_DE_TICKET}:${ticket.ticketId}:${AVISO_TICKET_NUEVO}`,
    });
    if (ticket.priority === TicketPriority.URGENT) {
      void this.correoASoporte(
        `Ticket urgente ${numero} de ${empresa}`,
        ticket.subject,
      );
    }
  }

  /** La plataforma le abrió un ticket a la empresa. */
  ticketDeLaPlataforma(ticket: SupportTicket): void {
    this.aLaEmpresa(
      ticket,
      AVISO_TICKET_NUEVO,
      `${this.plataforma()} te abrió el ticket ${numeroDeTicket(ticket.number)}`,
      `${ticket.subject}\nLo podés ver y responder en «Ayuda».`,
      ticket.ticketId,
    );
  }

  /** La plataforma respondió en el hilo (un aviso por mensaje). */
  respuestaDeLaPlataforma(ticket: SupportTicket, messageId: string): void {
    this.aLaEmpresa(
      ticket,
      AVISO_TICKET_RESPONDIDO,
      `${this.plataforma()} respondió el ticket ${numeroDeTicket(ticket.number)}`,
      ticket.subject,
      messageId,
    );
  }

  resuelto(ticket: SupportTicket): void {
    this.aLaEmpresa(
      ticket,
      AVISO_TICKET_RESUELTO,
      `El ticket ${numeroDeTicket(ticket.number)} quedó resuelto`,
      `${ticket.subject}\nSi está todo bien, confirmalo y calificá la atención; si no, respondé en el ticket.`,
      `${ticket.ticketId}:${ticket.resolvedAt?.toISOString() ?? ''}`,
    );
  }

  porCerrarse(ticket: SupportTicket, diasRestantes: number): void {
    this.aLaEmpresa(
      ticket,
      AVISO_TICKET_POR_CERRARSE,
      `El ticket ${numeroDeTicket(ticket.number)} espera tu respuesta`,
      `${ticket.subject}\nSi no respondés, se cierra en ${diasRestantes} días.`,
      `${ticket.ticketId}:${ticket.statusChangedAt.toISOString()}`,
    );
  }

  /** Objetivo de primera respuesta vencido: bandeja de la plataforma. */
  sinPrimeraRespuesta(ticket: SupportTicket, empresa: string): void {
    const numero = numeroDeTicket(ticket.number);
    pedirAvisoAlAdmin(this.events, this.logger, {
      distributorId: null,
      kind: AVISO_TICKET_SIN_RESPUESTA,
      title: `El ticket ${numero} de ${empresa} pasó su objetivo de respuesta`,
      body: ticket.subject,
      link: { entity: ENLACE_DE_TICKET, id: ticket.ticketId },
      dedupeKey: `${ENLACE_DE_TICKET}:${ticket.ticketId}:${AVISO_TICKET_SIN_RESPUESTA}`,
    });
  }

  private aLaEmpresa(
    ticket: SupportTicket,
    kind: string,
    title: string,
    body: string,
    clave: string,
  ): void {
    pedirAvisoAlAdmin(this.events, this.logger, {
      distributorId: ticket.distributorId,
      kind,
      title,
      body,
      link: { entity: ENLACE_DE_TICKET, id: ticket.ticketId },
      dedupeKey: `${ENLACE_DE_TICKET}:${clave}:${kind}`,
      email: true,
    });
  }

  private async correoASoporte(asunto: string, texto: string): Promise<void> {
    const casilla =
      this.config.get<ConfiguracionDePlataforma>('plataforma')?.supportEmail;
    if (!casilla) return;
    try {
      await this.correo.send({
        to: casilla,
        subject: asunto.replace(/\s+/g, ' ').trim(),
        html: `<h2>${escaparHtml(asunto)}</h2><p>${escaparHtml(texto)}</p>`,
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo mandar el correo a soporte (${asunto}): ${errorMessage(error)}`,
      );
    }
  }

  private plataforma(): string {
    return (
      this.config.get<ConfiguracionDePlataforma>('plataforma')?.name ??
      NOMBRE_DE_PLATAFORMA_POR_DEFECTO
    );
  }
}
