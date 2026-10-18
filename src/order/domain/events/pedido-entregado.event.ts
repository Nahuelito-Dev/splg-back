import { PaymentMethod } from '../../entities/order.entity';

/** Nombre del evento que emite `order` cuando un pedido pasa a entregado. */
export const EVENTO_PEDIDO_ENTREGADO = 'pedido.entregado';

/**
 * Un pedido se entregó (ya confirmado en la base). Lo que tenga que hacerse con
 * ese hecho fuera de `order` lo escucha: hoy, el cargo a cuenta corriente y la
 * comisión del chofer. Ninguno bloquea la entrega: si un oyente falla, un
 * proceso nocturno lo recupera (los asientos son idempotentes por pedido).
 */
export class PedidoEntregadoEvent {
  constructor(
    readonly orderId: string,
    readonly distributorId: string,
    readonly deliveryId: string | null,
    readonly customerId: string,
    readonly paymentMethod: PaymentMethod,
    readonly totalAmount: number,
    readonly deliveredAt: Date,
  ) {}
}
