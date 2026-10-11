import { EntityManager } from 'typeorm';

/** Lo que el stock necesita saber de un pedido que se acaba de entregar. */
export interface EntregaDePedido {
  orderId: string;
  distributorId: string;
  /** Vehículo con el que el chofer aceptó el pedido; puede ser null. */
  vehicleCarId: string | null;
  items: ReadonlyArray<{ gasCylinderId: string; quantity: number }>;
}

/**
 * PUERTO del stock físico visto desde el pedido: "este pedido se entregó".
 * El caso de uso de estado del pedido depende de ESTA interfaz, no del módulo
 * `stock`. Un adapter descuenta las llenas del camión (o del depósito) y suma
 * las vacías de canje.
 */
export abstract class StockDeliveryPort {
  /**
   * Corre por el `manager` de la transacción que tiene el pedido bloqueado:
   * escribir por otra conexión esperaría el lock del pedido (FK) y dejaría la
   * transacción colgada. Nunca bloquea la entrega: si no hay saldo donde
   * sacar, o si algo falla, lo registra y sigue (D5); la diferencia aparece
   * en la conciliación.
   */
  abstract onOrderDelivered(
    manager: EntityManager,
    entrega: EntregaDePedido,
  ): Promise<void>;
}
