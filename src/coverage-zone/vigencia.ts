import {
  finDelDiaArgentino,
  inicioDelDiaArgentino,
} from '../common/utils/dias-argentina';

const SOLO_DIA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * El instante de un extremo de vigencia. Un `YYYY-MM-DD` es un día de calendario
 * argentino: `desde` rige desde las 00:00 ART de ese día y `hasta` incluye el
 * día entero (vence a las 23:59:59.999 ART). Un instante con hora se respeta tal cual.
 * `NaN`-Date (inválido) si el texto no es una fecha.
 */
export function instanteDeVigencia(
  valor: string,
  extremo: 'desde' | 'hasta',
): Date {
  if (SOLO_DIA.test(valor)) {
    const instante =
      extremo === 'desde'
        ? inicioDelDiaArgentino(valor)
        : finDelDiaArgentino(valor);
    return instante ?? new Date(NaN);
  }
  return new Date(valor);
}
