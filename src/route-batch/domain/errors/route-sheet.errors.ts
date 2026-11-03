import {
  ConflictDomainError,
  DomainError,
} from '../../../common/errors/domain.error';
import { RouteBatchKind, RouteBatchStatus } from '../route-batch.enums';

/** Se intentó una transición de estado de un lote que su modalidad no admite. */
export class InvalidRouteBatchTransitionError extends ConflictDomainError {
  constructor(
    kind: RouteBatchKind,
    from: RouteBatchStatus,
    to: RouteBatchStatus,
  ) {
    super(
      kind === RouteBatchKind.PLANNED
        ? `La hoja de ruta no puede pasar de ${from} a ${to}`
        : `El lote no puede pasar de ${from} a ${to}`,
    );
  }
}

/**
 * La entrada de un algoritmo de ruteo no es válida (franja, punto, id repetido,
 * coordenada). Es una falla interna: los datos ya pasaron la validación del DTO
 * o salen de la base, así que si llegan acá hay un bug. Responde 500 con el
 * mensaje genérico (el detalle, con ids, queda en el log) y no 400: ese código
 * se reserva para lo que entra por el DTO.
 */
export class InvalidRouteInputError extends DomainError {
  constructor(detail: string) {
    super(`Datos inválidos para armar la hoja de ruta: ${detail}`);
  }
}

/** Un pedido de la hoja no tiene su carga en el mapa: no se asume que pesa cero. Falla interna (500, ver arriba). */
export class MissingStopLoadError extends DomainError {
  constructor(orderId: string) {
    super(`Falta la carga del pedido ${orderId} para calcular la capacidad`);
  }
}
