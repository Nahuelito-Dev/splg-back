/** Cómo va la corrida: pidió el reporte, ya se conciliaron las filas, o no se pudo. */
export enum MpReconciliationStatus {
  REQUESTED = 'requested',
  READY = 'ready',
  FAILED = 'failed',
}

/** Qué diferencia encontró la conciliación entre una fila del reporte y el libro de cajas. */
export enum MpDifferenceKind {
  /** Cobro en Mercado Pago de un pago nuestro que no tiene ingreso en la caja. */
  PAYMENT_NOT_IN_CASH = 'payment_not_in_cash',
  /** Ingreso en la caja de un cobro que el reporte del rango no trae (puede liberarse después). */
  LEDGER_WITHOUT_MP = 'ledger_without_mp',
  /** El ingreso de la caja es distinto del bruto del reporte. */
  AMOUNT_MISMATCH = 'amount_mismatch',
  /** El cobro entró sin su comisión («sin comisión informada» o pendiente). */
  FEE_PENDING = 'fee_pending',
  /** La comisión asentada es distinta de la del reporte. */
  FEE_MISMATCH = 'fee_mismatch',
  /** Impuestos o retenciones que Mercado Pago descontó de un cobro y no tienen egreso. */
  TAX_WITHHOLDING = 'tax_withholding',
  /** Impuesto o retención suelto del reporte (no pertenece a un cobro). */
  TAX_ROW = 'tax_row',
  /** Devolución o contracargo del reporte sin egreso en la caja. */
  REFUND_MISSING = 'refund_missing',
  /** Mercado Pago devolvió la comisión de un cobro devuelto. */
  FEE_REIMBURSEMENT = 'fee_reimbursement',
  /** Retiro de la billetera a una cuenta bancaria. */
  PAYOUT = 'payout',
  /** Cobro del reporte que no es de ninguna distribuidora. */
  UNKNOWN_PAYMENT = 'unknown_payment',
  /** Movimiento del reporte que el sistema no sabe asentar (reservas, envíos, disputas…). */
  OTHER_MOVEMENT = 'other_movement',
  /** Mercado Pago devolvió impuestos o retenciones en una devolución. */
  TAX_REFUND = 'tax_refund',
}

export enum MpItemStatus {
  PENDING = 'pending',
  APPLIED = 'applied',
}
