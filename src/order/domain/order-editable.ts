import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../entities/order.entity';

/** Por qué un pedido no se edita; `null` si se puede editar. */
export type NoEditable = {
  motivo: 'ESTADO' | 'PAGO_ONLINE';
  mensaje: string;
};

type PedidoParaEditar = Pick<
  Order,
  'status' | 'deliveryId' | 'paymentMethod' | 'paymentStatus'
>;

/**
 * Regla única de "¿se puede editar este pedido?": pendiente, sin chofer y sin
 * pago online en curso o cobrado. La usan `UpdateOrderUseCase` (para rechazar
 * con 409) y el DTO de salida (`editable`).
 */
export function motivoNoEditable(order: PedidoParaEditar): NoEditable | null {
  if (order.status !== OrderStatus.PENDING || order.deliveryId) {
    return {
      motivo: 'ESTADO',
      mensaje: `Sólo se edita un pedido pendiente sin chofer asignado (estado actual: ${order.status})`,
    };
  }
  if (
    order.paymentMethod === PaymentMethod.MERCADOPAGO ||
    order.paymentStatus !== PaymentStatus.PENDING
  ) {
    return {
      motivo: 'PAGO_ONLINE',
      mensaje:
        'El pedido tiene un pago online en curso o ya cobrado: no se edita',
    };
  }
  return null;
}

export function esEditable(order: PedidoParaEditar): boolean {
  return motivoNoEditable(order) === null;
}
