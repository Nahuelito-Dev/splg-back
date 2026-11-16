import Decimal from 'decimal.js';
import type { PaymentCheckoutItem } from '../../payments/domain/ports/payment-gateway.port';

/** Montos que se suman a los renglones de productos en un cobro de la pasarela. */
export interface RecargosDelCobro {
  zona: Decimal.Value;
  envases: Decimal.Value;
  online: Decimal.Value;
  express: Decimal.Value;
}

const renglonDeRecargo = (
  id: string,
  title: string,
  monto: Decimal.Value,
): PaymentCheckoutItem[] => {
  const unitPrice = new Decimal(monto).toDecimalPlaces(
    2,
    Decimal.ROUND_HALF_UP,
  );
  return unitPrice.isZero()
    ? []
    : [{ id, title, quantity: 1, unitPrice: unitPrice.toNumber() }];
};

/**
 * Renglones del checkout de un pedido: los productos más un renglón por cada
 * recargo que forma parte del total (zona, envases, pago online, express). La pasarela
 * tiene que cobrar EXACTAMENTE el total guardado en el ledger; si no, el control
 * de monto del webhook corta el despacho de un pago legítimo.
 */
export function renglonesDelCheckout(
  productos: PaymentCheckoutItem[],
  recargos: RecargosDelCobro,
): PaymentCheckoutItem[] {
  return [
    ...productos,
    ...renglonDeRecargo('zone-surcharge', 'Recargo de zona', recargos.zona),
    ...renglonDeRecargo('containers', 'Envases', recargos.envases),
    ...renglonDeRecargo(
      'online-surcharge',
      'Recargo por pago online',
      recargos.online,
    ),
    ...renglonDeRecargo(
      'express-surcharge',
      'Recargo express',
      recargos.express,
    ),
  ];
}
