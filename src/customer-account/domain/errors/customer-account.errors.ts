import {
  BadRequestDomainError,
  ConflictDomainError,
  NotFoundDomainError,
} from '../../../common/errors/domain.error';

export class CuentaNoEncontradaError extends NotFoundDomainError {
  constructor(readonly id: string) {
    super('Cuenta corriente no encontrada', `id=${id}`);
  }
}

export class ClienteNoEncontradoError extends NotFoundDomainError {
  constructor(readonly id: string) {
    super('Cliente no encontrado', `id=${id}`);
  }
}

export class CuentaConflictoError extends ConflictDomainError {
  constructor(mensaje: string) {
    super(mensaje);
  }
}

export class CuentaInvalidaError extends BadRequestDomainError {
  constructor(mensaje: string) {
    super(mensaje);
  }
}
