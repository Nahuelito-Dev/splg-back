import Decimal from 'decimal.js';
import { totalDeBase } from './deposit-cap';

/**
 * Lo que falta cobrar de un pedido: el total menos la seña, pero sólo la seña
 * ya paga. Una sola cuenta para el saldo del pedido, los cobros impagos y el
 * día a día del chofer.
 */
export const saldoPendiente = (
  total: Decimal.Value,
  sena: Decimal.Value,
  senaPagada: boolean,
): Decimal => totalDeBase(new Decimal(total).minus(senaPagada ? sena : 0));

/** La misma cuenta como expresión SQL sobre el alias de `Order` (para SUM en los informes). */
export const saldoPendienteSql = (alias: string): string =>
  `(${alias}.totalAmount - CASE WHEN ${alias}.depositPaid THEN ${alias}.depositAmount ELSE 0 END)`;
