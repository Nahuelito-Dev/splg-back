import { LedgerPaymentStatus as S } from './payment.enums';

/**
 * Máquina de estados del REGISTRO DE LEDGER de un pago, sobre los nueve estados
 * de la API de pagos de Mercado Pago. Un aviso atrasado o fuera de orden nunca
 * retrocede un pago: lo que ya se sabe del cobro no se pisa.
 *
 *  - PENDING      → cualquier otro (es lo primero que se ve de un pago)
 *  - IN_PROCESS   → AUTHORIZED | APPROVED | REJECTED | CANCELLED
 *  - AUTHORIZED   → IN_PROCESS | APPROVED | REJECTED | CANCELLED
 *  - APPROVED     → IN_MEDIATION | REFUNDED | CHARGED_BACK
 *  - IN_MEDIATION → APPROVED | REFUNDED | CHARGED_BACK (el reclamo se resuelve)
 *  - REJECTED, CANCELLED, REFUNDED, CHARGED_BACK: finales
 *
 * `APPROVED` después de `REFUNDED` o `CHARGED_BACK` no se aplica.
 */
export const LEDGER_TRANSITIONS: Readonly<Record<S, readonly S[]>> = {
  [S.PENDING]: [
    S.IN_PROCESS,
    S.AUTHORIZED,
    S.APPROVED,
    S.REJECTED,
    S.CANCELLED,
    S.IN_MEDIATION,
    S.REFUNDED,
    S.CHARGED_BACK,
  ],
  [S.IN_PROCESS]: [S.AUTHORIZED, S.APPROVED, S.REJECTED, S.CANCELLED],
  [S.AUTHORIZED]: [S.IN_PROCESS, S.APPROVED, S.REJECTED, S.CANCELLED],
  [S.APPROVED]: [S.IN_MEDIATION, S.REFUNDED, S.CHARGED_BACK],
  [S.IN_MEDIATION]: [S.APPROVED, S.REFUNDED, S.CHARGED_BACK],
  [S.REJECTED]: [],
  [S.CANCELLED]: [],
  [S.REFUNDED]: [],
  [S.CHARGED_BACK]: [],
};

/** ¿Puede el pago pasar de `desde` a `hacia`? Repetir el mismo estado es un no-op válido. */
export function puedeTransicionarElPago(desde: S, hacia: S): boolean {
  return desde === hacia || LEDGER_TRANSITIONS[desde].includes(hacia);
}

/** Estados en que el dinero ya fue acreditado al comercio (aunque haya un reclamo abierto). */
export const ESTADOS_COBRADOS: readonly S[] = [S.APPROVED, S.IN_MEDIATION];

/** ¿El pago está acreditado y no se devolvió ni se perdió por contracargo? */
export function pagoCobrado(estado: S): boolean {
  return ESTADOS_COBRADOS.includes(estado);
}

/** Estados en que el pago todavía puede terminar en un cobro (esperar; no cancelar el pedido). */
export const ESTADOS_EN_CURSO: readonly S[] = [
  S.PENDING,
  S.IN_PROCESS,
  S.AUTHORIZED,
];

/** Estados en que el comprador puede volver a intentar con el mismo checkout. */
export const ESTADOS_REINTENTABLES: readonly S[] = [S.REJECTED, S.CANCELLED];

/** Diferencia máxima tolerada entre lo cobrado y lo esperado (un centavo). */
const TOLERANCIA_MONTO = 0.01;

/** ¿Lo que la pasarela cobró coincide con el importe esperado del pago? */
export function montoCoincide(esperado: number, cobrado: number): boolean {
  return Math.abs(esperado - cobrado) < TOLERANCIA_MONTO / 2 + 1e-9;
}

/** Texto del estado crudo de la pasarela → estado del ledger; lo desconocido se trata como pendiente. */
export function estadoDelLedgerDesde(estadoDeLaPasarela: string): S {
  return (Object.values(S) as string[]).includes(estadoDeLaPasarela)
    ? (estadoDeLaPasarela as S)
    : S.PENDING;
}

/** Largo máximo de `payment.status_detail` (columna `varchar(100)`). */
export const LARGO_MAXIMO_DEL_DETALLE = 100;

/**
 * El `status_detail` que informa la pasarela, listo para guardar: sin espacios en los
 * bordes, `null` si viene vacío o en blanco (la base lo rechaza con
 * `CHK_payment_detalle_del_estado`) y recortado al largo de la columna.
 */
export function normalizarDetalleDelEstado(
  detalle: string | null | undefined,
): string | null {
  const limpio = (detalle ?? '').trim();
  return limpio === '' ? null : limpio.slice(0, LARGO_MAXIMO_DEL_DETALLE);
}
