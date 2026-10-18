export enum CustomerAccountStatus {
  ACTIVE = 'active',
  BLOCKED = 'blocked',
  CLOSED = 'closed',
}

export enum TaxCondition {
  REGISTERED = 'registered',
  MONOTAX = 'monotax',
  EXEMPT = 'exempt',
  FINAL_CONSUMER = 'final_consumer',
}

/**
 * Tipo de asiento de la cuenta corriente. El cargo de una venta y la nota de
 * débito suben la deuda (debe); el pago y la nota de crédito la bajan (haber).
 */
export enum CustomerEntryType {
  SALE_CHARGE = 'sale_charge',
  PAYMENT = 'payment',
  CREDIT_NOTE = 'credit_note',
  DEBIT_NOTE = 'debit_note',
}

/** Tipo de ajuste manual que acepta el administrador. */
export enum AdjustmentKind {
  CREDIT = 'credit',
  DEBIT = 'debit',
}

/** Rangos de antigüedad de la deuda, en días desde la fecha del comprobante. */
export enum AgingBucket {
  D0_30 = 'd0_30',
  D31_60 = 'd31_60',
  D61_90 = 'd61_90',
  D90_PLUS = 'd90_plus',
}
