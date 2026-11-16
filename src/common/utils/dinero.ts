import Decimal from 'decimal.js';

/** Un importe de la base (`numeric` llega como texto) o del dominio, como `Decimal`. */
export function dec(valor: Decimal.Value | null | undefined): Decimal {
  return new Decimal(valor ?? 0);
}

/** Redondea a centavos (mitad hacia arriba) y vuelve a número para guardar. */
export function aCentavos(valor: Decimal.Value): number {
  return new Decimal(valor)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toNumber();
}

/** Suma exacta de una lista de importes. */
export function sumar(
  valores: Iterable<Decimal.Value | null | undefined>,
): Decimal {
  let total = new Decimal(0);
  for (const v of valores) total = total.plus(v ?? 0);
  return total;
}
