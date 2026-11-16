/**
 * Mensajería (diseño `splg-docs/sistema/DISENO-COMUNICACION.md`). CH1: C1, el
 * chat con la plataforma (`platform_chat`) y el hilo de cada ticket
 * (`platform_ticket`). CH3: la bandeja de la empresa, con sus clientes
 * (`staff_customer`, C3) y sus choferes (`staff_driver`, C2). C4 se suma en su
 * etapa, ampliando estos enums y los CHECK de la base en la misma migración.
 */
export enum Channel {
  PLATFORM_CHAT = 'platform_chat',
  PLATFORM_TICKET = 'platform_ticket',
  STAFF_CUSTOMER = 'staff_customer',
  STAFF_DRIVER = 'staff_driver',
}

/** Los canales de la bandeja de la empresa (módulo `chat`). */
export const CANALES_DE_LA_BANDEJA: readonly Channel[] = [
  Channel.STAFF_CUSTOMER,
  Channel.STAFF_DRIVER,
];

const CANALES_DE_LA_BANDEJA_EN_TEXTO: ReadonlySet<string> = new Set([
  'staff_customer',
  'staff_driver',
]);

export function esCanalDeLaBandeja(
  canal: Channel | string,
): canal is Channel.STAFF_CUSTOMER | Channel.STAFF_DRIVER {
  return CANALES_DE_LA_BANDEJA_EN_TEXTO.has(canal);
}

/** De qué se habla: general, un pedido o (el hilo de un ticket) el ticket. */
export enum SubjectType {
  GENERAL = 'general',
  TICKET = 'ticket',
  ORDER = 'order',
}

/** Una punta de la conversación (un equipo o una persona) o el sistema. */
export enum Party {
  PLATFORM = 'platform',
  COMPANY = 'company',
  CUSTOMER = 'customer',
  DRIVER = 'driver',
  SYSTEM = 'system',
}

/** Las partes que pueden leer y escribir (sin el sistema). */
export type PartyQueHabla =
  | Party.PLATFORM
  | Party.COMPANY
  | Party.CUSTOMER
  | Party.DRIVER;

/** Las dos puntas de C1 (chat con la plataforma y tickets). */
export type PartyDeC1 = Party.PLATFORM | Party.COMPANY;

/** La persona del otro lado de la empresa en la bandeja: el cliente (C3) o el chofer (C2). */
export type PartyDeLaPersona = Party.CUSTOMER | Party.DRIVER;

/** La punta de la persona en cada canal de la bandeja. */
export function personaDelCanal(
  canal: Channel.STAFF_CUSTOMER | Channel.STAFF_DRIVER,
): PartyDeLaPersona {
  return canal === Channel.STAFF_CUSTOMER ? Party.CUSTOMER : Party.DRIVER;
}

export enum ConversationStatus {
  OPEN = 'open',
  CLOSED = 'closed',
}

export enum ConversationClosedReason {
  MANUAL = 'manual',
  INACTIVITY = 'inactivity',
  TICKET_CLOSED = 'ticket_closed',
  /** C2 por pedido: el pedido pasó a otro chofer (o volvió a buscar uno). */
  DRIVER_CHANGED = 'driver_changed',
}

export enum MessageKind {
  TEXT = 'text',
  SYSTEM = 'system',
  AUTO_REPLY = 'auto_reply',
  QUOTED_EXCERPT = 'quoted_excerpt',
  /** Un archivo o una foto (CH7, §9): uno por mensaje; `body` es su epígrafe (≤ 500). */
  ATTACHMENT = 'attachment',
}

export enum MessageVisibility {
  ALL = 'all',
  /**
   * Nota interna: la de la plataforma en el hilo de un ticket (D-C8) y la del
   * personal de la empresa en la bandeja (C3, C2), con su nota de derivación
   * del asistente con IA. Nunca la ve la otra punta.
   */
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
  /** La empresa volvió a abrir una conversación de la bandeja. */
  REOPENED = 'reopened',
  /** C2 por pedido: se cerró porque el pedido pasó a otro chofer. */
  DRIVER_CHANGED = 'driver_changed',
  /** Se creó un reclamo desde la conversación (C3). */
  CLAIM_CREATED = 'claim_created',
  /**
   * Nota interna del asistente con IA al pasar la conversación a una persona
   * (C3): resumen y motivo, sólo para el equipo. El texto va en `body`.
   */
  HANDOFF_NOTE = 'handoff_note',
  /**
   * Encuesta de satisfacción al cerrar una conversación con un cliente (4b):
   * el texto en `body` y `{ ratingId, expiresAt, scale }` en `payload`.
   */
  CSAT_REQUEST = 'csat_request',
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

/**
 * Respuestas guardadas: rápidas de la plataforma, la automática fuera de
 * horario de la plataforma y las rápidas de cada empresa (CH3).
 */
export enum MessageTemplateScope {
  PLATFORM_REPLY = 'platform_reply',
  AUTO_REPLY = 'auto_reply',
  STAFF_REPLY = 'staff_reply',
}

/** Clave de la respuesta automática del chat fuera del horario de la plataforma. */
export const PLANTILLA_FUERA_DE_HORARIO = 'fuera_de_horario';

/** Clave (`template_key`) de las respuestas del asistente con IA (B3). */
export const PLANTILLA_DEL_ASISTENTE_IA = 'asistente_ia';

/** Clave del aviso automático de recibido en horario (D-C29). */
export const PLANTILLA_RECIBIDO = 'recibido';
