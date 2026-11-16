import Decimal from 'decimal.js';
import { diasEntre, sumarDias } from '../../common/utils/dias-argentina';

/** Suma `valores` con aritmética decimal y la devuelve a 2 decimales. */
export function sumar(valores: number[]): number {
  return valores
    .reduce((acc, v) => acc.plus(v), new Decimal(0))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toNumber();
}

/** Ticket promedio: ventas / pedidos, a 2 decimales; 0 si no hubo pedidos. */
export function ticketPromedio(ventas: number, pedidos: number): number {
  if (pedidos <= 0) return 0;
  return new Decimal(ventas)
    .div(pedidos)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toNumber();
}

/**
 * Las filas de mayor a menor venta; a igual venta, por `desempate` (nombre o
 * id), así el orden no cambia entre consultas.
 */
export function mayorVentaPrimero<T extends { totalSales: number }>(
  filas: T[],
  desempate: (fila: T) => string,
): T[] {
  return [...filas].sort(
    (a, b) =>
      b.totalSales - a.totalSales ||
      desempate(a).localeCompare(desempate(b), 'es'),
  );
}

/** El período inmediato anterior, de la misma cantidad de días (`YYYY-MM-DD`, extremos inclusivos). */
export function periodoAnterior(
  desde: string,
  hasta: string,
): { desde: string; hasta: string } {
  const largo = diasEntre(desde, hasta) + 1;
  return { desde: sumarDias(desde, -largo), hasta: sumarDias(desde, -1) };
}
