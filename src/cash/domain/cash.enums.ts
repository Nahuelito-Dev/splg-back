/** Tipo de caja: efectivo (no admite saldo negativo), banco o billetera virtual. */
export enum CashBoxKind {
  CASH = 'cash',
  BANK = 'bank',
  WALLET = 'wallet',
}

export enum CashSessionStatus {
  OPEN = 'open',
  CLOSED = 'closed',
}

/** Sentido de un movimiento del libro: entra o sale dinero de la caja. */
export enum CashDirection {
  IN = 'in',
  OUT = 'out',
}

/** Medio con que se movió el dinero (informativo). */
export enum CashMethod {
  CASH = 'cash',
  TRANSFER = 'transfer',
  CARD = 'card',
  MERCADOPAGO = 'mercadopago',
  CHECK = 'check',
}

/** Qué originó el movimiento: la operación manual o el documento que lo generó. */
export enum CashReferenceType {
  MANUAL = 'manual',
  SESSION_OPENING = 'session_opening',
  SESSION_CLOSING = 'session_closing',
  DRIVER_SETTLEMENT = 'driver_settlement',
  CUSTOMER_PAYMENT = 'customer_payment',
  PURCHASE_RECEIPT = 'purchase_receipt',
  FUEL_LOAD = 'fuel_load',
  TRAFFIC_FINE = 'traffic_fine',
  DRIVER_LIQUIDATION = 'driver_liquidation',
  BOX_TRANSFER = 'box_transfer',
  REVERSAL = 'reversal',
  ORDER_PAYMENT = 'order_payment',
  INSURANCE_INSTALLMENT = 'insurance_installment',
  MAINTENANCE_TASK = 'maintenance_task',
  TIRE = 'tire',
  VEHICLE_ACCIDENT = 'vehicle_accident',
  INSURANCE_REIMBURSEMENT = 'insurance_reimbursement',
  /** Cobro aprobado por Mercado Pago: la referencia es el id del `payment` del libro de pagos. */
  PAYMENT = 'payment',
  /** Comisión que Mercado Pago retuvo de un cobro: la referencia es el id del `payment`. */
  PAYMENT_FEE = 'payment_fee',
  /** Devolución de un cobro de Mercado Pago: la referencia es el id del `payment_refund`. */
  PAYMENT_REFUND = 'payment_refund',
  /** Transferencia confirmada por el administrador: la referencia es el id del pedido. */
  ORDER_TRANSFER = 'order_transfer',
  /** Devolución o contracargo que Mercado Pago hizo por su cuenta (sin solicitud nuestra): la referencia es el id del `payment`. */
  PAYMENT_EXTERNAL_REFUND = 'payment_external_refund',
  /** Seña de una reserva recibida en efectivo o por transferencia: la referencia es el id del pedido. */
  ORDER_DEPOSIT = 'order_deposit',
}

/** Sentido de una categoría: los ingresos y los gastos no se mezclan. */
export enum CategoryDirection {
  INCOME = 'income',
  EXPENSE = 'expense',
}

/**
 * Categorías que siembra el sistema por distribuidora y que usan las demás
 * operaciones (rendición, cobro de cuenta corriente, pago de liquidación…).
 * No se editan ni se desactivan.
 */
export enum CashSystemCode {
  DRIVER_SETTLEMENT = 'driver_settlement',
  CUSTOMER_PAYMENT = 'customer_payment',
  COMMISSION_PAYMENT = 'commission_payment',
  CASH_SURPLUS = 'cash_surplus',
  CASH_SHORTAGE = 'cash_shortage',
  TRANSFER_IN = 'transfer_in',
  TRANSFER_OUT = 'transfer_out',
  PURCHASE = 'purchase',
  FUEL = 'fuel',
  TRAFFIC_FINE = 'traffic_fine',
  ORDER_PAYMENT = 'order_payment',
  INSURANCE = 'insurance',
  FLEET_MAINTENANCE = 'fleet_maintenance',
  TIRES = 'tires',
  VEHICLE_ACCIDENT = 'vehicle_accident',
  INSURANCE_REIMBURSEMENT = 'insurance_reimbursement',
  MERCADOPAGO_FEE = 'mercadopago_fee',
  CUSTOMER_REFUND = 'customer_refund',
}

/** Las categorías de sistema con su nombre y su sentido, tal como se siembran. */
export const CATEGORIAS_DE_SISTEMA: ReadonlyArray<{
  code: CashSystemCode;
  name: string;
  direction: CategoryDirection;
}> = [
  {
    code: CashSystemCode.DRIVER_SETTLEMENT,
    name: 'Rendición de chofer',
    direction: CategoryDirection.INCOME,
  },
  {
    code: CashSystemCode.CUSTOMER_PAYMENT,
    name: 'Cobro de cuenta corriente',
    direction: CategoryDirection.INCOME,
  },
  {
    code: CashSystemCode.COMMISSION_PAYMENT,
    name: 'Pago de comisiones',
    direction: CategoryDirection.EXPENSE,
  },
  {
    code: CashSystemCode.CASH_SURPLUS,
    name: 'Sobrante de caja',
    direction: CategoryDirection.INCOME,
  },
  {
    code: CashSystemCode.CASH_SHORTAGE,
    name: 'Faltante de caja',
    direction: CategoryDirection.EXPENSE,
  },
  {
    code: CashSystemCode.TRANSFER_IN,
    name: 'Transferencia entre cajas (entrada)',
    direction: CategoryDirection.INCOME,
  },
  {
    code: CashSystemCode.TRANSFER_OUT,
    name: 'Transferencia entre cajas (salida)',
    direction: CategoryDirection.EXPENSE,
  },
  {
    code: CashSystemCode.PURCHASE,
    name: 'Compra de mercadería',
    direction: CategoryDirection.EXPENSE,
  },
  {
    code: CashSystemCode.FUEL,
    name: 'Combustible',
    direction: CategoryDirection.EXPENSE,
  },
  {
    code: CashSystemCode.TRAFFIC_FINE,
    name: 'Multa de tránsito',
    direction: CategoryDirection.EXPENSE,
  },
  {
    code: CashSystemCode.ORDER_PAYMENT,
    name: 'Cobro de pedido',
    direction: CategoryDirection.INCOME,
  },
  {
    code: CashSystemCode.INSURANCE,
    name: 'Seguros',
    direction: CategoryDirection.EXPENSE,
  },
  {
    code: CashSystemCode.FLEET_MAINTENANCE,
    name: 'Mantenimiento de flota',
    direction: CategoryDirection.EXPENSE,
  },
  {
    code: CashSystemCode.TIRES,
    name: 'Neumáticos',
    direction: CategoryDirection.EXPENSE,
  },
  {
    code: CashSystemCode.VEHICLE_ACCIDENT,
    name: 'Siniestros',
    direction: CategoryDirection.EXPENSE,
  },
  {
    code: CashSystemCode.INSURANCE_REIMBURSEMENT,
    name: 'Reintegros de seguros',
    direction: CategoryDirection.INCOME,
  },
  {
    code: CashSystemCode.MERCADOPAGO_FEE,
    name: 'Comisiones de Mercado Pago',
    direction: CategoryDirection.EXPENSE,
  },
  {
    code: CashSystemCode.CUSTOMER_REFUND,
    name: 'Devoluciones a clientes',
    direction: CategoryDirection.EXPENSE,
  },
];

export const NOMBRE_CAJA_CENTRAL = 'Caja central';
