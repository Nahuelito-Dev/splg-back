/**
 * El envase volvió: pasó de estar en poder de un cliente a `empty_returned`.
 * Lo escucha el recupero de envases (CU-108) para cerrar el caso abierto sin
 * esperar a la próxima corrida.
 */
export const EVENTO_ENVASE_DEVUELTO = 'cylinder.returned';

export class EnvaseDevueltoEvent {
  constructor(
    readonly distributorId: string,
    readonly cylinderId: string,
    /** Cliente que lo tenía. */
    readonly customerId: string | null,
    readonly orderId: string | null,
  ) {}
}
