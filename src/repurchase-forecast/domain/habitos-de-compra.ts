import { PaymentMethod } from '../../order/entities/order.entity';
import type { CompraEntregadaRef } from '../../order/lookup/order-lookup.service';
import type { CompraEntregada } from './estimacion-de-recompra';

/** Lo que el cliente suele pedir: es la sugerencia de la invitación. */
export interface HabitosDeCompra {
  /** Los renglones de su última compra. */
  items: Array<{ gasCylinderId: string; quantity: number }>;
  /** La dirección a la que más le entregaron. */
  addressId: string;
  /** La franja que más usó, si usó alguna. */
  timeSlotId: string | null;
  paymentMethod: PaymentMethod;
}

/** Medios de pago que se sugieren: el crédito de cuenta corriente lo carga el administrador. */
const MEDIOS_SUGERIBLES: readonly PaymentMethod[] = [
  PaymentMethod.CASH,
  PaymentMethod.TRANSFER,
  PaymentMethod.MERCADOPAGO,
];

/** El valor más repetido; si empatan, el más reciente (las compras vienen de la más vieja a la más nueva). */
function masFrecuente<T>(valores: readonly T[]): T | undefined {
  const cuentas = new Map<T, number>();
  for (const v of valores) cuentas.set(v, (cuentas.get(v) ?? 0) + 1);
  let mejor: T | undefined;
  let mayor = 0;
  for (const v of [...valores].reverse()) {
    const n = cuentas.get(v) ?? 0;
    if (n > mayor) {
      mejor = v;
      mayor = n;
    }
  }
  return mejor;
}

/** Los kilos de gas de una compra entregada. */
export function kilosDeLaCompra(compra: CompraEntregadaRef): number {
  return compra.items.reduce((suma, i) => suma + i.quantity * i.weightKg, 0);
}

export function comoEstimacion(compra: CompraEntregadaRef): CompraEntregada {
  return { deliveredAt: compra.deliveredAt, kg: kilosDeLaCompra(compra) };
}

/**
 * Qué suele pedir el cliente. `compras` va de la más vieja a la más nueva y no
 * puede estar vacía.
 */
export function habitosDe(
  compras: readonly CompraEntregadaRef[],
): HabitosDeCompra {
  const ultima = compras[compras.length - 1];
  const direccion = masFrecuente(compras.map((c) => c.addressId));
  const franja = masFrecuente(
    compras.flatMap((c) => (c.timeSlotId ? [c.timeSlotId] : [])),
  );
  const pago = masFrecuente(
    compras
      .map((c) => c.paymentMethod)
      .filter((m) => MEDIOS_SUGERIBLES.includes(m)),
  );
  return {
    items: ultima.items.map((i) => ({
      gasCylinderId: i.gasCylinderId,
      quantity: i.quantity,
    })),
    addressId: direccion ?? ultima.addressId,
    timeSlotId: franja ?? null,
    paymentMethod: pago ?? PaymentMethod.CASH,
  };
}
