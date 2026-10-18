import {
  BadRequestDomainError,
  ConflictDomainError,
  NotFoundDomainError,
} from '../../../common/errors/domain.error';

export class ReglaNoEncontradaError extends NotFoundDomainError {
  constructor(id: string) {
    super(`Regla de comisión no encontrada: ${id}`);
  }
}

export class LiquidacionNoEncontradaError extends NotFoundDomainError {
  constructor(id: string) {
    super(`Liquidación no encontrada: ${id}`);
  }
}

export class EmpleadoNoEncontradoError extends NotFoundDomainError {
  constructor(id: string) {
    super(`Empleado no encontrado: ${id}`);
  }
}

export class ProductoNoEncontradoError extends NotFoundDomainError {
  constructor(id: string) {
    super(`Producto no encontrado: ${id}`);
  }
}

export class ComisionInvalidaError extends BadRequestDomainError {
  constructor(mensaje: string) {
    super(mensaje);
  }
}

export class ComisionConflictoError extends ConflictDomainError {
  constructor(mensaje: string) {
    super(mensaje);
  }
}
