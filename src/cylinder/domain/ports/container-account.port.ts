import type { Transaccion } from './unit-of-work.port';

/** PUERTO de la cuenta de envases del cliente vista desde envases. */
export abstract class ContainerAccountPort {
  /**
   * Volvió un envase que el cliente tenía: su cuenta baja uno, dentro de la
   * misma transacción que la devolución. Si falla, la devolución revierte.
   */
  abstract descontarPropioDevuelto(
    tx: Transaccion,
    datos: {
      distributorId: string;
      customerUserId: string;
      cylinderId: string;
      orderId: string | null;
    },
  ): Promise<void>;
}
