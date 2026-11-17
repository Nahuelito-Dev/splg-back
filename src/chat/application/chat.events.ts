import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { errorMessage } from '../../common/errors/error-message';
import type { Channel, PartyQueHabla } from '../domain/chat.enums';
import type { Conversation } from '../entities/conversation.entity';
import type { Message } from '../entities/message.entity';
import type { SupportTicket } from '../entities/support-ticket.entity';

/** Eventos de dominio de la mensajería: se emiten después del commit y los lleva al socket `ChatRealtimeListener`. */
export const EVENTO_MENSAJE_CREADO = 'chat.mensaje.creado';
export const EVENTO_CONVERSACION_CAMBIO = 'chat.conversacion.cambio';
export const EVENTO_LECTURA = 'chat.lectura';
export const EVENTO_TICKET = 'chat.ticket';
export const EVENTO_MENSAJE_EDITADO = 'chat.mensaje.editado';
export const EVENTO_MENSAJE_BORRADO = 'chat.mensaje.borrado';
/**
 * Un mensaje que no cambió de texto pero sí lo que se muestra de él (el
 * escaneo de su adjunto terminó, CH7): se vuelve a mandar `chat:message` a
 * las salas de la conversación; las listas no se tocan (no es un mensaje nuevo).
 */
export const EVENTO_MENSAJE_ACTUALIZADO = 'chat.mensaje.actualizado';

/**
 * Cambiaron los ajustes de la asignación automática de una empresa (se
 * prendió o cambió el tope, 8b): se reparte la cola.
 */
export const EVENTO_AJUSTES_DE_ASIGNACION = 'chat.asignacion.ajustes';

export interface AjustesDeAsignacionCambiados {
  distributorId: string;
}

export type CambioDeConversacion =
  | 'created'
  | 'assigned'
  | 'closed'
  | 'reopened'
  | 'status'
  /** Le pusieron o sacaron etiquetas (7c): sólo el panel se entera. */
  | 'labels';

export interface MensajeCreado {
  conversation: Conversation;
  message: Message;
}

export interface ConversacionCambiada {
  conversation: Conversation;
  change: CambioDeConversacion;
  /**
   * En `assigned`: a quién estaba asignada antes (le bajó la carga, para la
   * asignación automática, 8b). No va al socket.
   */
  previousAssignedToUserId?: string | null;
}

export interface LecturaRegistrada {
  conversationId: string;
  distributorId: string;
  channel: Channel;
  party: PartyQueHabla;
  lastReadSeq: number;
  /** Quién leyó: sus otras pestañas apagan el contador. */
  userId: string;
  /** Subió la lectura de la persona. */
  personal: boolean;
  /** Subió la de su punta (lo que la otra ve como «leído»). */
  deLaParte: boolean;
}

/** Un mensaje propio editado (D-C22): la otra punta lo actualiza en vivo. */
export interface MensajeEditado {
  conversation: Conversation;
  message: Message;
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
  readonly ediciones: MensajeEditado[] = [];
  readonly borrados: MensajeEditado[] = [];
  readonly actualizaciones: MensajeEditado[] = [];

  mensaje(conversation: Conversation, message: Message): this {
    this.mensajes.push({ conversation, message });
    return this;
  }

  conversacion(
    conversation: Conversation,
    change: CambioDeConversacion,
    previousAssignedToUserId?: string | null,
  ): this {
    this.conversaciones.push(
      previousAssignedToUserId === undefined
        ? { conversation, change }
        : { conversation, change, previousAssignedToUserId },
    );
    return this;
  }

  edicion(conversation: Conversation, message: Message): this {
    this.ediciones.push({ conversation, message });
    return this;
  }

  /** Un mensaje que su autor borró (D-C23): las dos puntas lo muestran borrado. */
  borrado(conversation: Conversation, message: Message): this {
    this.borrados.push({ conversation, message });
    return this;
  }

  /** El adjunto del mensaje terminó de escanearse (CH7): las salas lo vuelven a recibir. */
  actualizacion(conversation: Conversation, message: Message): this {
    this.actualizaciones.push({ conversation, message });
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
    for (const e of efectos.ediciones) this.emitir(EVENTO_MENSAJE_EDITADO, e);
    for (const b of efectos.borrados) this.emitir(EVENTO_MENSAJE_BORRADO, b);
    for (const a of efectos.actualizaciones) {
      this.emitir(EVENTO_MENSAJE_ACTUALIZADO, a);
    }
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
