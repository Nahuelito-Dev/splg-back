/**
 * Errores de DOMINIO (no de HTTP). El dominio puro (state machines, reserva de
 * stock, etc.) no debe conocer `@nestjs/common` ni el concepto de status HTTP
 * — eso es un detalle de la capa web. En vez de `BadRequestException`/
 * `NotFoundException`, el dominio lanza subclases de `DomainError`, y
 * `GlobalExceptionFilter` (`src/common/filters/global-exception.filter.ts`) las
 * mapea al status HTTP correspondiente, así la respuesta al cliente NO cambia
 * (P2-9 de `docs/ARQUITECTURA-REVIEW.md`).
 *
 * Tres categorías, según cómo se deben mapear:
 *  - `BadRequestDomainError` → 400 (transición/input/estado inválido)
 *  - `NotFoundDomainError`   → 404 (recurso de dominio inexistente)
 *  - `ConflictDomainError`   → 409 (el estado actual no admite la operación)
 *
 * Los módulos (order, cylinder, ...) declaran sus errores concretos extendiendo
 * una de estas dos (ver `order/domain/errors/` y `cylinder/domain/errors/`).
 */
export abstract class DomainError extends Error {
  /**
   * Dato interno (un id, por ejemplo) que va al log y nunca a la respuesta:
   * `message` es lo único que ve el cliente.
   */
  readonly detalle?: string;

  protected constructor(message: string, detalle?: string) {
    super(message);
    this.detalle = detalle;
    this.name = new.target.name;
  }
}

/** Mapeada a 400 Bad Request por el GlobalExceptionFilter. */
export abstract class BadRequestDomainError extends DomainError {}

/** Mapeada a 404 Not Found por el GlobalExceptionFilter. */
export abstract class NotFoundDomainError extends DomainError {}

/** Mapeada a 409 Conflict por el GlobalExceptionFilter (el estado no admite la operación). */
export abstract class ConflictDomainError extends DomainError {}

/** Un error con dato interno (`detalle`) para el log: de dominio, o la excepción HTTP que lo reemplazó. */
export function detalleDe(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const detalle = (error as { detalle?: unknown }).detalle;
  return typeof detalle === 'string' && detalle !== '' ? detalle : undefined;
}

/** La misma excepción HTTP, con el `detalle` del error de dominio del que viene. */
export function conDetalle<T extends Error>(excepcion: T, origen: unknown): T {
  const detalle = detalleDe(origen);
  return detalle ? Object.assign(excepcion, { detalle }) : excepcion;
}
