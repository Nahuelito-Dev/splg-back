import { LedgerPaymentStatus as S } from './payment.enums';

/** Texto genérico de un rechazo: el que se usa cuando Mercado Pago no da un motivo que sepamos explicar. */
export const RECHAZO_GENERICO = 'Rechazado por el banco';

/**
 * Motivos de rechazo (`status_detail` de un pago `rejected`) con el texto que ve
 * quien paga. La lista de códigos es la de la documentación de Mercado Pago:
 * https://www.mercadopago.com.ar/developers/en/docs/checkout-api-payments/response-handling/query-results
 */
const MOTIVOS_DE_RECHAZO: Readonly<Record<string, string>> = {
  cc_rejected_bad_filled_card_number: 'Revisá el número de la tarjeta',
  cc_rejected_bad_filled_date: 'Revisá la fecha de vencimiento de la tarjeta',
  cc_rejected_bad_filled_other: 'Revisá los datos de la tarjeta',
  cc_rejected_bad_filled_security_code:
    'Revisá el código de seguridad de la tarjeta',
  cc_rejected_call_for_authorize:
    'Tenés que autorizar el pago con tu banco o tarjeta',
  cc_rejected_card_disabled:
    'La tarjeta está deshabilitada: activala con tu banco o usá otra',
  cc_rejected_duplicated_payment:
    'Ya hiciste un pago por ese valor: usá otro medio de pago si querés pagar de nuevo',
  cc_rejected_insufficient_amount: 'Fondos insuficientes en el medio de pago',
  insufficient_amount: 'Fondos insuficientes en el medio de pago',
  cc_rejected_invalid_installments:
    'El medio de pago no acepta esa cantidad de cuotas',
  cc_rejected_max_attempts:
    'Llegaste al límite de intentos: usá otra tarjeta u otro medio de pago',
  cc_rejected_high_risk:
    'Rechazado por seguridad: probá con otro medio de pago',
  rejected_high_risk: 'Rechazado por seguridad: probá con otro medio de pago',
  cc_rejected_blacklist: 'No se pudo procesar el pago',
  cc_rejected_3ds_challenge:
    'No se completó la validación de seguridad de la tarjeta',
  cc_rejected_3ds_mandatory:
    'La tarjeta exige una validación de seguridad que no se hizo',
  cc_rejected_time_out:
    'Mercado Pago no recibió respuesta a tiempo: probá de nuevo',
  cc_amount_rate_limit_exceeded: 'Superaste el límite del medio de pago',
  bank_error: 'Error del banco: probá de nuevo o usá otro medio de pago',
  rejected_insufficient_data: 'Faltan datos obligatorios para procesar el pago',
  rejected_by_bank: RECHAZO_GENERICO,
  rejected_by_regulations: 'Rechazado por normativa vigente',
  rejected_by_biz_rule: 'Rechazado por las reglas del comercio',
  cc_rejected_other_reason: RECHAZO_GENERICO,
  rejected_other_reason: RECHAZO_GENERICO,
};

const ETIQUETA_POR_ESTADO: Readonly<Record<S, string>> = {
  [S.PENDING]: 'Esperando el pago',
  [S.IN_PROCESS]: 'Pago en revisión',
  [S.AUTHORIZED]: 'Pago autorizado, pendiente de confirmación',
  [S.APPROVED]: 'Pago acreditado',
  [S.REJECTED]: RECHAZO_GENERICO,
  [S.CANCELLED]: 'Pago cancelado',
  [S.REFUNDED]: 'Pago devuelto',
  [S.CHARGED_BACK]: 'Contracargo sobre el pago',
  [S.IN_MEDIATION]: 'Reclamo en curso sobre el pago',
};

const ETIQUETA_POR_DETALLE: Readonly<
  Record<string, Partial<Record<S, string>>>
> = {
  pending_waiting_payment: { [S.PENDING]: 'Esperando que completes el pago' },
  pending_waiting_transfer: {
    [S.PENDING]: 'Esperando que termines la transferencia',
  },
  pending_challenge: {
    [S.PENDING]: 'Falta confirmar el pago con la validación de la tarjeta',
  },
  offline_process: { [S.IN_PROCESS]: 'Pago en revisión' },
  pending_contingency: {
    [S.IN_PROCESS]: 'Pago en revisión: se acredita en menos de 2 días hábiles',
  },
  pending_review_manual: {
    [S.IN_PROCESS]: 'Pago en revisión: te avisamos en menos de 2 días hábiles',
  },
  deferred_retry: { [S.IN_PROCESS]: 'Pago en revisión: se vuelve a intentar' },
  partially_refunded: {
    [S.APPROVED]: 'Pago acreditado, con una devolución parcial',
  },
  expired: { [S.CANCELLED]: 'Pago vencido: pasó el plazo para pagar' },
  by_payer: { [S.CANCELLED]: 'Pago cancelado por quien pagaba' },
  by_collector: { [S.CANCELLED]: 'Pago cancelado por el comercio' },
  settled: {
    [S.CHARGED_BACK]: 'Contracargo: el dinero quedó retenido',
  },
  reimbursed: {
    [S.CHARGED_BACK]: 'Contracargo: el dinero fue reintegrado',
  },
  by_admin: { [S.REFUNDED]: 'Pago devuelto por Mercado Pago' },
};

/**
 * El texto en castellano del estado de un pago, armado por el back (las apps y el
 * panel lo muestran tal cual, no lo reinterpretan). Para un rechazo, el motivo
 * (`status_detail`); sin motivo conocido, «Rechazado por el banco».
 */
export function etiquetaDelPago(
  estado: S,
  detalle: string | null | undefined,
): string {
  if (estado === S.REJECTED) {
    return (detalle && MOTIVOS_DE_RECHAZO[detalle]) || RECHAZO_GENERICO;
  }
  return (
    (detalle && ETIQUETA_POR_DETALLE[detalle]?.[estado]) ||
    ETIQUETA_POR_ESTADO[estado]
  );
}
