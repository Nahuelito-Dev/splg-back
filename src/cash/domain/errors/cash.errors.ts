import {
  BadRequestDomainError,
  NotFoundDomainError,
} from '../../../common/errors/domain.error';

export class CajaNoEncontradaError extends NotFoundDomainError {
  constructor(readonly id: string) {
    super('Caja no encontrada', `id=${id}`);
  }
}

export class SesionNoEncontradaError extends NotFoundDomainError {
  constructor(readonly id: string) {
    super('Sesión de caja no encontrada', `id=${id}`);
  }
}

export class CategoriaNoEncontradaError extends NotFoundDomainError {
  constructor(readonly id: string) {
    super('Categoría de caja no encontrada', `id=${id}`);
  }
}

export class MovimientoNoEncontradoError extends NotFoundDomainError {
  constructor(readonly id: string) {
    super('Movimiento de caja no encontrado', `id=${id}`);
  }
}

export class MovimientoInvalidoError extends BadRequestDomainError {
  constructor(motivo: string) {
    super(motivo);
  }
}
