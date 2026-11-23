import { saldoACobrar } from '../../truck-load/domain/truck-load-rules';

/** Lo que hace falta del pedido para saber cuánto efectivo se cobra al entregar. */
export interface PedidoParaCobrar {
  paymentMethod: string;
  paymentStatus: string;
  status: string;
  total: number;
  depositAmount: number;
  depositPaid: boolean;
}

const ESTADOS_CERRADOS = ['delivered', 'cancelled'];

/** Lo que se paga en efectivo al entregar y la seña que ya viene descontada (0 si no hay). */
export interface DesgloseDelEfectivo {
  monto: number;
  senaDescontada: number;
}

/**
 * El efectivo que el chofer cobra en la puerta: el total menos la seña, sólo si
 * el pedido es en efectivo, todavía no se cobró y sigue en curso. La seña se
 * descuenta si ya está paga o si es una reserva (la seña está comprometida
 * aunque el admin todavía no la haya confirmado: al entregar se paga el saldo).
 * `null` si no hay nada que cobrar (otro medio de pago, ya cobrado, entregado,
 * cancelado o saldo cero). Es la única fuente del monto: las apps no calculan.
 */
export function desgloseDelEfectivo(
  p: PedidoParaCobrar,
): DesgloseDelEfectivo | null {
  if (p.paymentMethod !== 'cash' || p.paymentStatus !== 'pending') return null;
  if (ESTADOS_CERRADOS.includes(p.status)) return null;
  const senaDescontada =
    p.depositPaid || p.status === 'reserved' ? p.depositAmount : 0;
  const monto = saldoACobrar(p.total, senaDescontada);
  return monto > 0 ? { monto, senaDescontada } : null;
}

export function efectivoACobrar(p: PedidoParaCobrar): number | null {
  return desgloseDelEfectivo(p)?.monto ?? null;
}

/** «$12.500», o «$12.500,50» si no es redondo: el monto tal como se le dice a una persona. */
export function montoEnPesos(monto: number): string {
  const entero = Number.isInteger(monto);
  return `$${monto.toLocaleString('es-AR', {
    minimumFractionDigits: entero ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

type PedidoEntidad = {
  paymentMethod: string;
  paymentStatus: string;
  status: string;
  totalAmount: number | string;
  depositAmount?: number | string | null;
  depositPaid?: boolean | null;
};

/** El mismo cálculo sobre la entidad del pedido (ofertas y avisos). */
export function efectivoDelPedido(o: PedidoEntidad): number | null {
  return desgloseDelPedido(o)?.monto ?? null;
}

/** El desglose (monto y seña descontada) sobre la entidad del pedido. */
export function desgloseDelPedido(
  o: PedidoEntidad,
): DesgloseDelEfectivo | null {
  return desgloseDelEfectivo({
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    status: o.status,
    total: Number(o.totalAmount),
    depositAmount: Number(o.depositAmount ?? 0),
    depositPaid: !!o.depositPaid,
  });
}

/** Un monto es «redondo» si es de pesos enteros y múltiplo de 100: se paga con billetes sin vuelto. */
export function esMontoRedondo(monto: number): boolean {
  return Number.isInteger(monto) && monto % 100 === 0;
}

/** Al confirmar el pedido: lo que se paga cuando lo entreguen (y la seña ya descontada, si hay). */
export function textoDelEfectivoAlConfirmar(
  monto: number,
  senaDescontada = 0,
): string {
  const descuento =
    senaDescontada > 0
      ? ` (ya descontada la seña de ${montoEnPesos(senaDescontada)})`
      : '';
  return `Pagás ${montoEnPesos(monto)} en efectivo cuando te lo entreguen${descuento}.`;
}

/**
 * Identifica una salida del chofer hacia el pedido: el chofer asignado y los
 * intentos fallidos de la parada. Si cambia (otro chofer, o el chofer vuelve
 * después de una entrega fallida) es una salida nueva y se vuelve a avisar.
 */
export function claveDeSalida(
  deliveryId: string | null | undefined,
  intentosFallidos: number | null | undefined,
): string {
  return `${deliveryId ?? 'sin-chofer'}:${intentosFallidos ?? 0}`;
}

/** Lo que identifica un aviso de efectivo al salir: el monto avisado y la salida. */
export interface EfectivoDeSalida {
  monto: number;
  salida: string;
}

/** Cuando el chofer sale: tené el efectivo listo (y, si no es redondo, el monto exacto). */
export function textoDelEfectivoAlSalir(monto: number): string {
  const base = `Tené listos ${montoEnPesos(monto)} en efectivo.`;
  return esMontoRedondo(monto)
    ? base
    : `${base} Si podés, juntá el monto exacto: el chofer puede no tener vuelto.`;
}
