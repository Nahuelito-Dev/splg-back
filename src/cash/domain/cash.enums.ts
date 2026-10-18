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
];

export const NOMBRE_CAJA_CENTRAL = 'Caja central';
