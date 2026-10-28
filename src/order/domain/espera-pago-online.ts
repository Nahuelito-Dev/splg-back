import { PaymentMethod, PaymentStatus } from '../entities/order.entity';

/** Lo mínimo del pedido que decide si ya puede salir. */
export interface PagoDelPedido {
  paymentMethod: PaymentMethod | `${PaymentMethod}`;
  paymentStatus: PaymentStatus | `${PaymentStatus}`;
  depositPaid?: boolean | null;
}

/** 409 de la asignación o la aceptación de un pedido que espera el pago online. */
export const MENSAJE_MP_SIN_PAGAR =
  'El pedido se paga con Mercado Pago y todavía no está pago: se le asigna chofer cuando se apruebe el pago';

/**
 * Un pedido de Mercado Pago no sale hasta que el pago esté aprobado: no se
 * ofrece, no aparece entre los disponibles, el chofer no lo acepta y el admin
 * no lo asigna. La excepción es la reserva con la seña paga: el saldo se cobra
 * al entregar, así que `paymentStatus` sigue `pending` a propósito.
 */
export function esperaPagoOnline(pedido: PagoDelPedido): boolean {
  return (
    pedido.paymentMethod === PaymentMethod.MERCADOPAGO &&
    pedido.paymentStatus !== PaymentStatus.PAID &&
    !pedido.depositPaid
  );
}
