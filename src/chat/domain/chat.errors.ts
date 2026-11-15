import {
  BadRequestDomainError,
  ConflictDomainError,
  NotFoundDomainError,
} from '../../common/errors/domain.error';
import { CODIGOS_DE_ERROR } from '../../common/errors/con-codigo';

/** La conversación no existe, es de otra empresa o de un canal que no corresponde. */
export class ConversacionNoEncontradaError extends NotFoundDomainError {
  constructor() {
    super('No existe esa conversación');
  }
}

export class TicketNoEncontradoError extends NotFoundDomainError {
  constructor() {
    super('No existe ese ticket');
  }
}

export class ConversacionCerradaError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.CONVERSATION_CLOSED;
  constructor() {
    super('La conversación está cerrada.');
  }
}

export class TicketCerradoError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.TICKET_CLOSED;
  constructor() {
    super('El ticket está cerrado. Si el problema sigue, abrí uno nuevo.');
  }
}

export class TicketNoResueltoError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.TICKET_NOT_RESOLVED;
  constructor() {
    super('El ticket todavía no está resuelto.');
  }
}

/** Una transición que la máquina del ticket no permite (§4.2.2). */
export class TransicionDeTicketInvalidaError extends BadRequestDomainError {
  override readonly code = CODIGOS_DE_ERROR.TICKET_INVALID_TRANSITION;
  constructor(de: string, a: string) {
    super(`No se puede pasar el ticket de ${de} a ${a}.`);
  }
}

/** Rango de mensajes del chat fuera del chat, invertido o de más de 200 mensajes. */
export class CitaInvalidaError extends BadRequestDomainError {
  override readonly code = CODIGOS_DE_ERROR.TICKET_EXCERPT_INVALID;
  constructor() {
    super('Elegí entre 1 y 200 mensajes del chat.');
  }
}

/** Nota interna fuera del hilo de un ticket, o de alguien que no es la plataforma (D-C8). */
export class NotaInternaNoPermitidaError extends BadRequestDomainError {
  override readonly code = CODIGOS_DE_ERROR.INTERNAL_NOTE_NOT_ALLOWED;
  constructor() {
    super('Las notas internas sólo se pueden dejar en un ticket.');
  }
}

/** La conversación ya la atiende otra persona de la plataforma. */
export class ConversacionYaTomadaError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.CONVERSATION_ALREADY_TAKEN;
  constructor() {
    super('Otra persona del soporte ya está atendiendo este chat.');
  }
}
