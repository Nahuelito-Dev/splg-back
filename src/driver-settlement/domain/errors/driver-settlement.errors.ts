import {
  BadRequestDomainError,
  ConflictDomainError,
  NotFoundDomainError,
} from '../../../common/errors/domain.error';

export class RendicionNoEncontradaError extends NotFoundDomainError {
  constructor(readonly id: string) {
    super('Rendición no encontrada', `id=${id}`);
  }
}

export class ChoferNoEncontradoError extends NotFoundDomainError {
  constructor(readonly id: string) {
    super('Chofer no encontrado', `id=${id}`);
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
