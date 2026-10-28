import { RefundKind } from '../payment.enums';

/** Nombres de los eventos que `payments` emite al resolver una devolución (CU-168). */
export const EVENTO_PAGO_REINTEGRADO = 'pago.reintegrado';
export const EVENTO_REINTEGRO_FALLIDO = 'pago.reintegro-fallido';

/** Datos comunes: `payments` no sabe de pedidos, sólo de quién y cuánto. */
export interface ReintegroResuelto {
  orderId: string;
  refundId: string;
  paymentId: string;
  distributorId: string | null;
  kind: RefundKind;
  amount: number;
  /** Intentos hechos: distingue un fallo nuevo de un reintento del mismo. */
  attempts: number;
}

/** La pasarela confirmó la devolución (o ya estaba devuelta). */
export class PagoReintegradoEvent {
  constructor(readonly reintegro: ReintegroResuelto) {}
}

/** La pasarela rechazó la devolución o no respondió. */
export class ReintegroFallidoEvent {
  constructor(
    readonly reintegro: ReintegroResuelto,
    readonly motivo: string,
  ) {}
}
