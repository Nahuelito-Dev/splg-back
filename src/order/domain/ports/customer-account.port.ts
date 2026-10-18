import Decimal from 'decimal.js';
import { EntityManager } from 'typeorm';

/**
 * PUERTO de la cuenta corriente del cliente visto desde el pedido: "puede
 * comprar a cuenta por este total". El alta de pedido depende de ESTA
 * interfaz, no del módulo `customer-account`; un adaptador la resuelve.
 */
export abstract class CustomerAccountPort {
  /**
   * Corre por el `manager` de la transacción del pedido: bloquea la cuenta del
   * cliente (`FOR UPDATE`) para que dos pedidos simultáneos no superen el
   * límite entre los dos. Rechaza con 409 si el cliente no tiene cuenta, no
   * está activa o el total supera el crédito disponible.
   */
  abstract assertCredito(
    manager: EntityManager,
    distributorId: string,
    customerId: string,
    total: Decimal.Value,
  ): Promise<void>;
}
