import { BadRequestException } from '@nestjs/common';

/**
 * Las escrituras de stock y de compras que generan movimientos con ids nuevos
 * exigen el header `Idempotency-Key` (UUID v4): sin él, un reintento de red
 * ejecuta la operación otra vez y duplica el movimiento. Sin clave responde 400
 * antes de tocar nada.
 */
export function exigirIdempotencyKey(
  clave: string | undefined,
  operacion: string,
): void {
  if (!clave?.trim()) {
    throw new BadRequestException(
      `${operacion} exige el header Idempotency-Key (UUID v4): sin él un reintento duplicaría el movimiento`,
    );
  }
}
