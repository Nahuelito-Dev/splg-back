import {
  BadRequestDomainError,
  ConflictDomainError,
  NotFoundDomainError,
} from '../../../common/errors/domain.error';

export class RendicionNoEncontradaError extends NotFoundDomainError {
  constructor(id: string) {
    super(`Rendición no encontrada: ${id}`);
  }
}

export class ChoferNoEncontradoError extends NotFoundDomainError {
  constructor(id: string) {
    super(`Chofer no encontrado: ${id}`);
  }
}

export class RendicionEnOtroEstadoError extends ConflictDomainError {
  constructor(mensaje: string) {
    super(mensaje);
  }
}

export class RendicionInvalidaError extends BadRequestDomainError {
  constructor(mensaje: string) {
    super(mensaje);
  }
}

export class RendicionConflictoError extends ConflictDomainError {
  constructor(mensaje: string) {
    super(mensaje);
  }
}
