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
 *
 * Son los nueve estados de la API de pagos de Mercado Pago (valor idéntico al
 * `status` que informa):
 * https://www.mercadopago.com.ar/developers/en/docs/checkout-api-payments/response-handling/query-results
 */
export enum LedgerPaymentStatus {
  PENDING = 'pending',
  IN_PROCESS = 'in_process',
  AUTHORIZED = 'authorized',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled',
  REFUNDED = 'refunded',
  CHARGED_BACK = 'charged_back',
  IN_MEDIATION = 'in_mediation',
}

/** De dónde salió una lectura del estado de un pago (queda en el historial). */
export enum OrigenDelEstadoDelPago {
  WEBHOOK = 'webhook',
  CONCILIACION = 'conciliacion',
  CONSULTA = 'consulta',
  /** Lo hizo el propio sistema: una devolución pedida desde acá. */
  REINTEGRO = 'reintegro',
}

/** Qué parte de un pago se devuelve (CU-168). */
export enum RefundKind {
  /** Todo lo que falta devolver del pago: el pedido se canceló. */
  FULL = 'full',
  /** Sólo el recargo express: el pedido pasó al reparto común. */
  EXPRESS_SURCHARGE = 'express_surcharge',
}

/** Estado de una solicitud de devolución a la pasarela. */
export enum RefundStatus {
  /** Registrada, todavía sin respuesta de la pasarela. */
  PENDING = 'pending',
  SUCCEEDED = 'succeeded',
  /** La pasarela la rechazó o no respondió: el administrador puede reintentarla. */
  FAILED = 'failed',
}
