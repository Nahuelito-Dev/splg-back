/**
 * Mensajería (diseño `splg-docs/sistema/DISENO-COMUNICACION.md`). Esta etapa
 * (CH1) implementa sólo C1: el chat con la plataforma (`platform_chat`) y el
 * hilo de cada ticket (`platform_ticket`). Los canales de C2–C4 se suman en
 * sus etapas, ampliando estos enums y los CHECK de la base en la misma
 * migración.
 */
export enum Channel {
  PLATFORM_CHAT = 'platform_chat',
  PLATFORM_TICKET = 'platform_ticket',
}

/** De qué se habla: el chat es general; el hilo de un ticket, del ticket. */
export enum SubjectType {
  GENERAL = 'general',
  TICKET = 'ticket',
}

/** Una punta de la conversación (un equipo, no una persona) o el sistema. */
export enum Party {
  PLATFORM = 'platform',
  COMPANY = 'company',
  SYSTEM = 'system',
}

/** Las partes que pueden leer y escribir (sin el sistema). */
export type PartyQueHabla = Party.PLATFORM | Party.COMPANY;

export enum ConversationStatus {
  OPEN = 'open',
  CLOSED = 'closed',
}

export enum ConversationClosedReason {
  MANUAL = 'manual',
  INACTIVITY = 'inactivity',
  TICKET_CLOSED = 'ticket_closed',
}

export enum MessageKind {
  TEXT = 'text',
  SYSTEM = 'system',
  AUTO_REPLY = 'auto_reply',
  QUOTED_EXCERPT = 'quoted_excerpt',
}

export enum MessageVisibility {
  ALL = 'all',
  /** Nota interna de la plataforma: sólo en el hilo de un ticket (D-C8). */
  INTERNAL = 'internal',
}

/**
 * Mensajes de sistema: el texto lo arma el front con la clave, en castellano.
 * `payload` lleva lo que hace falta para armarlo.
 */
export enum SystemCode {
  CONVERSATION_OPENED = 'conversation_opened',
  TICKET_OPENED = 'ticket_opened',
  TICKET_CREATED = 'ticket_created',
  TICKET_STATUS_CHANGED = 'ticket_status_changed',
  CLOSED_INACTIVITY = 'closed_inactivity',
  CLOSED_MANUAL = 'closed_manual',
  ASSIGNED = 'assigned',
  /** Aviso automático en horario al primer mensaje de la empresa (D-C29). */
  RECEIVED_ACK = 'received_ack',
}

export enum TicketStatus {
  NEW = 'new',
  OPEN = 'open',
  WAITING_COMPANY = 'waiting_company',
  RESOLVED = 'resolved',
  CLOSED = 'closed',
}

export enum TicketPriority {
  LOW = 'low',
  NORMAL = 'normal',
  HIGH = 'high',
  URGENT = 'urgent',
}

export enum TicketCategory {
  BILLING = 'billing',
  TECHNICAL = 'technical',
  MODULE = 'module',
  DATA = 'data',
  ACCOUNT = 'account',
  OTHER = 'other',
}

/** Respuestas guardadas: rápidas de la plataforma y la automática fuera de horario. */
export enum MessageTemplateScope {
  PLATFORM_REPLY = 'platform_reply',
  AUTO_REPLY = 'auto_reply',
}

/** Clave de la respuesta automática del chat fuera del horario de la plataforma. */
export const PLANTILLA_FUERA_DE_HORARIO = 'fuera_de_horario';

/** Clave del aviso automático de recibido en horario (D-C29). */
export const PLANTILLA_RECIBIDO = 'recibido';
