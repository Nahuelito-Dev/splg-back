/** Sobre qué se calcula la comisión de una regla. */
export enum CommissionBasis {
  /** `value` pesos por cada garrafa entregada. */
  PER_UNIT = 'per_unit',
  /** `value` pesos por pedido entregado. */
  PER_ORDER = 'per_order',
  /** `value` por ciento del subtotal del renglón (0 a 100). */
  PERCENT_OF_TOTAL = 'percent_of_total',
}

export enum CommissionEntryType {
  DELIVERY_COMMISSION = 'delivery_commission',
  SETTLEMENT_SHORTAGE = 'settlement_shortage',
  TRAFFIC_FINE = 'traffic_fine',
  ADJUSTMENT = 'adjustment',
  LEGACY_BALANCE = 'legacy_balance',
}

export enum LiquidationStatus {
  DRAFT = 'draft',
  APPROVED = 'approved',
  PAID = 'paid',
  VOIDED = 'voided',
}
