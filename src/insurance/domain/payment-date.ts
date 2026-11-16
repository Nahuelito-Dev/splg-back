import { inicioDelDiaArgentino } from '../../common/utils/dias-argentina';

const SOLO_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * El instante de un pago. Una fecha sin hora es ese día en hora argentina (su
 * primer instante), nunca medianoche UTC —que caería la noche anterior—; con
 * hora (ISO 8601 con zona) es ese instante.
 */
export function instanteDelPago(texto: string): Date {
  if (SOLO_FECHA.test(texto)) {
    return inicioDelDiaArgentino(texto) ?? new Date(NaN);
  }
  return new Date(texto);
}
