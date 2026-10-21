import { LedgerPaymentStatus } from './payment.enums';

/**
 * Máquina de estados del REGISTRO DE LEDGER de un pago. Un pago aprobado no
 * vuelve a pendiente ni a rechazado por una notificación atrasada: lo único que
 * le puede pasar es devolverse. Los estados finales (rechazado, cancelado,
 * devuelto) no cambian.
 *
 *  - PENDING  → APPROVED | REJECTED | CANCELLED | REFUNDED
 *  - APPROVED → REFUNDED
 */
export const LEDGER_TRANSITIONS: Readonly<
  Record<LedgerPaymentStatus, readonly LedgerPaymentStatus[]>
> = {
  [LedgerPaymentStatus.PENDING]: [
    LedgerPaymentStatus.APPROVED,
    LedgerPaymentStatus.REJECTED,
    LedgerPaymentStatus.CANCELLED,
    LedgerPaymentStatus.REFUNDED,
  ],
  [LedgerPaymentStatus.APPROVED]: [LedgerPaymentStatus.REFUNDED],
  [LedgerPaymentStatus.REJECTED]: [],
  [LedgerPaymentStatus.CANCELLED]: [],
  [LedgerPaymentStatus.REFUNDED]: [],
};

/** ¿Puede el pago pasar de `desde` a `hacia`? Repetir el mismo estado es un no-op válido. */
export function puedeTransicionarElPago(
  desde: LedgerPaymentStatus,
  hacia: LedgerPaymentStatus,
): boolean {
  return desde === hacia || LEDGER_TRANSITIONS[desde].includes(hacia);
}

/** Diferencia máxima tolerada entre lo cobrado y lo esperado (un centavo). */
const TOLERANCIA_MONTO = 0.01;

/** ¿Lo que la pasarela cobró coincide con el importe esperado del pago? */
export function montoCoincide(esperado: number, cobrado: number): boolean {
  return Math.abs(esperado - cobrado) < TOLERANCIA_MONTO / 2 + 1e-9;
}
