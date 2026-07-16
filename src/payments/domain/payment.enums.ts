/**
 * Enums del dominio de pagos. Viven separados del entity/port para que
 * cualquier capa (application, infrastructure, futuros adapters) los importe
 * sin arrastrar TypeORM ni el SDK de una pasarela concreta.
 */

/** Pasarela de pago concreta que originó el intento de cobro. */
export enum PaymentGateway {
  MERCADOPAGO = 'mercadopago',
  CASH = 'cash',
}

/** Producto/integración DENTRO de la pasarela (Checkout Pro, efectivo, etc.). */
export enum PaymentIntegration {
  CHECKOUT_PRO = 'checkout_pro',
  CASH = 'cash',
}

/**
 * Estado del REGISTRO DE LEDGER (`Payment`), no confundir con
 * `order.entities.PaymentStatus` (pending/paid/failed), que refleja el estado
 * del PEDIDO. Un pedido puede tener varios intentos de pago (varios `Payment`)
 * antes de quedar pagado; este enum describe cada intento individual.
 */
export enum LedgerPaymentStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled',
  REFUNDED = 'refunded',
}
