/**
 * Vacaciones según el artículo 150 de la Ley de Contrato de Trabajo: días
 * corridos que corresponden por la antigüedad al 31 de diciembre del año.
 * Función pura: no consulta datos. Es una referencia para el administrador,
 * no una liquidación: no descuenta licencias sin goce ni ausencias, ni calcula
 * el proporcional de quien ingresó en el año.
 */

const DIAS_POR_TRAMO: ReadonlyArray<{ masDeAnios: number; dias: number }> = [
  { masDeAnios: 20, dias: 35 },
  { masDeAnios: 10, dias: 28 },
  { masDeAnios: 5, dias: 21 },
];
const DIAS_BASE = 14;

/** `fecha` + `anios` años, en día calendario `YYYY-MM-DD` (un 29/02 pasa al 01/03 en año no bisiesto). */
function sumarAnios(fecha: string, anios: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + anios);
  return d.toISOString().slice(0, 10);
}

/**
 * 14 días si la antigüedad al 31/12 no excede los 5 años, 21 si excede 5 y no
 * 10, 28 si excede 10 y no 20, y 35 si excede 20. "Excede" es estricto: con
 * exactamente 5 años cumplidos el 31/12 todavía corresponden 14. Quien ingresó
 * después del 31/12 no tiene días ese año.
 */
export function diasDeVacacionesPorAntiguedad(
  fechaDeIngreso: string,
  anio: number,
): number {
  const cierre = `${anio}-12-31`;
  if (fechaDeIngreso > cierre) return 0;
  for (const tramo of DIAS_POR_TRAMO) {
    if (sumarAnios(fechaDeIngreso, tramo.masDeAnios) < cierre)
      return tramo.dias;
  }
  return DIAS_BASE;
}

/** Cuántos días del período `[inicio, fin]` caen dentro de `anio` (extremos incluidos). */
export function diasDentroDelAnio(
  inicio: string,
  fin: string,
  anio: number,
): number {
  const desde = inicio > `${anio}-01-01` ? inicio : `${anio}-01-01`;
  const hasta = fin < `${anio}-12-31` ? fin : `${anio}-12-31`;
  if (hasta < desde) return 0;
  const ms =
    Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}
