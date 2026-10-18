import Decimal from 'decimal.js';
import {
  CashBoxKind,
  CashDirection,
  CashReferenceType,
  CategoryDirection,
} from './cash.enums';

/** Saldo de la caja después de aplicar un movimiento (exacto, sin flotantes). */
export function saldoDespuesDe(
  saldo: Decimal.Value,
  direccion: CashDirection,
  importe: Decimal.Value,
): Decimal {
  const base = new Decimal(saldo);
  return direccion === CashDirection.IN
    ? base.plus(importe)
    : base.minus(importe);
}

/** Una caja de efectivo no puede quedar en negativo; banco y billetera sí. */
export function dejaSaldoNegativoEnEfectivo(
  tipo: CashBoxKind,
  saldoResultante: Decimal.Value,
): boolean {
  return tipo === CashBoxKind.CASH && new Decimal(saldoResultante).isNegative();
}

/** La categoría tiene que ser del mismo sentido que el movimiento. */
export function categoriaCoincideConElSentido(
  direccion: CashDirection,
  categoria: CategoryDirection,
): boolean {
  return direccion === CashDirection.IN
    ? categoria === CategoryDirection.INCOME
    : categoria === CategoryDirection.EXPENSE;
}

export function sentidoOpuesto(direccion: CashDirection): CashDirection {
  return direccion === CashDirection.IN ? CashDirection.OUT : CashDirection.IN;
}

/**
 * Arqueo: lo esperado es la apertura más lo que se movió en la sesión (las
 * entradas suman y las salidas restan); la diferencia es lo contado menos lo
 * esperado (negativa: faltante; positiva: sobrante).
 */
export function arqueo(
  apertura: Decimal.Value,
  entradas: Decimal.Value,
  salidas: Decimal.Value,
  contado: Decimal.Value,
): { esperado: Decimal; diferencia: Decimal } {
  const esperado = new Decimal(apertura).plus(entradas).minus(salidas);
  return { esperado, diferencia: new Decimal(contado).minus(esperado) };
}

/** Una caja nueva de efectivo exige sesión por omisión; banco y billetera no. */
export function requiereSesionPorOmision(tipo: CashBoxKind): boolean {
  return tipo === CashBoxKind.CASH;
}

/**
 * Sólo los movimientos manuales se anulan con un contraasiento suelto: los
 * demás nacen de un documento (rendición, cobro, liquidación…) que tiene su
 * propia corrección, y anularlos a mano dejaría la caja y el documento en
 * desacuerdo. `null` si se puede anular; si no, por dónde se corrige.
 */
export function motivoDeNoAnulable(tipo: CashReferenceType): string | null {
  switch (tipo) {
    case CashReferenceType.MANUAL:
      return null;
    case CashReferenceType.BOX_TRANSFER:
      return 'Es una pata de una transferencia entre cajas: anulá la transferencia completa (POST /cash-movements/:id/reverse-transfer)';
    case CashReferenceType.DRIVER_LIQUIDATION:
      return 'Es el pago de una liquidación de comisiones: se corrige anulando el pago de la liquidación (PATCH /driver-liquidations/:id/unpay)';
    case CashReferenceType.CUSTOMER_PAYMENT:
      return 'Es el cobro de una cuenta corriente: se corrige con un ajuste en la cuenta corriente del cliente';
    case CashReferenceType.DRIVER_SETTLEMENT:
      return 'Es el efectivo de una rendición aprobada: una aprobada no se reabre; el desvío se corrige con un movimiento manual que lo explique';
    case CashReferenceType.SESSION_OPENING:
    case CashReferenceType.SESSION_CLOSING:
      return 'Es un ajuste de apertura o de arqueo de una sesión de caja: se corrige con la sesión siguiente o con un movimiento manual que lo explique';
    case CashReferenceType.PURCHASE_RECEIPT:
    case CashReferenceType.FUEL_LOAD:
    case CashReferenceType.TRAFFIC_FINE:
      return 'Lo generó otro documento (compra, combustible o multa): se corrige desde ese documento';
    case CashReferenceType.REVERSAL:
      return 'Es una anulación: no se anula. Si estuvo mal, registrá un movimiento nuevo';
  }
}
