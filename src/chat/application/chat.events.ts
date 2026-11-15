import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { errorMessage } from '../../common/errors/error-message';
import type { Party } from '../domain/chat.enums';
import type { Conversation } from '../entities/conversation.entity';
import type { Message } from '../entities/message.entity';
import type { SupportTicket } from '../entities/support-ticket.entity';

/** Eventos de dominio de la mensajería: se emiten después del commit y los lleva al socket `ChatRealtimeListener`. */
export const EVENTO_MENSAJE_CREADO = 'chat.mensaje.creado';
export const EVENTO_CONVERSACION_CAMBIO = 'chat.conversacion.cambio';
export const EVENTO_LECTURA = 'chat.lectura';
export const EVENTO_TICKET = 'chat.ticket';

export type CambioDeConversacion =
  | 'created'
  | 'assigned'
  | 'closed'
  | 'reopened'
  | 'status';

export interface MensajeCreado {
  conversation: Conversation;
  message: Message;
}

export interface ConversacionCambiada {
  conversation: Conversation;
  change: CambioDeConversacion;
}

export interface LecturaRegistrada {
  conversationId: string;
  distributorId: string;
  party: Party.COMPANY | Party.PLATFORM;
  lastReadSeq: number;
  /** Quién leyó: sus otras pestañas apagan el contador. */
  userId: string;
  /** Subió la lectura de la persona. */
  personal: boolean;
  /** Subió la de su punta (lo que la otra ve como «leído»). */
  deLaParte: boolean;
}

export interface TicketCambiado {
  ticket: SupportTicket;
  change: 'created' | 'updated';
}

/**
 * Lo que una operación deja para avisar después del commit. Si el back se cae
 * entre el commit y el aviso, el mensaje ya está en la base y la otra punta lo
 * trae al reconectar (§7.4).
 */
export class Efectos {
  readonly mensajes: MensajeCreado[] = [];
  readonly conversaciones: ConversacionCambiada[] = [];
  readonly tickets: TicketCambiado[] = [];

  mensaje(conversation: Conversation, message: Message): this {
    this.mensajes.push({ conversation, message });
    return this;
  }

  conversacion(conversation: Conversation, change: CambioDeConversacion): this {
    this.conversaciones.push({ conversation, change });
    return this;
  }

  ticket(ticket: SupportTicket, change: 'created' | 'updated'): this {
    this.tickets.push({ ticket, change });
    return this;
  }
}

/** Emite los efectos de una operación ya confirmada. Best-effort: nunca rompe la respuesta. */
@Injectable()
export class ChatEvents {
  private readonly logger = new Logger(ChatEvents.name);

  constructor(private readonly events: EventEmitter2) {}

  publicar(efectos: Efectos): void {
    for (const c of efectos.conversaciones) {
      this.emitir(EVENTO_CONVERSACION_CAMBIO, c);
    }
    for (const m of efectos.mensajes) this.emitir(EVENTO_MENSAJE_CREADO, m);
    for (const t of efectos.tickets) this.emitir(EVENTO_TICKET, t);
  }

  lectura(evento: LecturaRegistrada): void {
    this.emitir(EVENTO_LECTURA, evento);
  }

  private emitir(nombre: string, carga: unknown): void {
    try {
      this.events.emit(nombre, carga);
    } catch (error) {
      this.logger.warn(`No se pudo emitir ${nombre}: ${errorMessage(error)}`);
    }
  }
}
