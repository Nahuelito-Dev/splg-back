/**
 * Días hábiles de una distribuidora para la hoja de ruta: los días de la semana
 * en que reparte (`route_planning.workingDays`) menos sus feriados. Funciones
 * puras sobre fechas `AAAA-MM-DD` (el día argentino, sin hora).
 *
 * `workingDays` es una máscara de bits de los días ISO: lunes = 1, martes = 2,
 * miércoles = 4, jueves = 8, viernes = 16, sábado = 32, domingo = 64. Por
 * omisión 63 (lunes a sábado).
 */

/** Lunes a sábado. */
export const DIAS_HABILES_POR_OMISION = 63;

/** Hasta dónde se busca el próximo día hábil (más de un año de feriados no hay). */
const TOPE_DE_DIAS = 400;

export interface CalendarioLaboral {
  /** Días de la semana ISO (1 lunes … 7 domingo) en que se reparte. */
  diasHabiles: ReadonlySet<number>;
  /** Feriados de la distribuidora (`AAAA-MM-DD`). */
  feriados: ReadonlySet<string>;
}

/** Los días ISO de la máscara (bit `d - 1` para el día `d`). */
export function diasDeLaMascara(mascara: number): Set<number> {
  const dias = new Set<number>();
  for (let d = 1; d <= 7; d++) {
    if ((mascara >> (d - 1)) & 1) dias.add(d);
  }
  return dias;
}

export const CALENDARIO_POR_OMISION: CalendarioLaboral = {
  diasHabiles: diasDeLaMascara(DIAS_HABILES_POR_OMISION),
  feriados: new Set(),
};

/** El día de la semana ISO de la fecha (1 lunes … 7 domingo). */
export function diaDeLaSemana(fecha: string): number {
  const d = new Date(`${fecha}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

export function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

export function esDiaHabil(fecha: string, cal: CalendarioLaboral): boolean {
  return cal.diasHabiles.has(diaDeLaSemana(fecha)) && !cal.feriados.has(fecha);
}

/**
 * El primer día hábil después de `fecha`: saltea los días que la distribuidora
 * no reparte y sus feriados. Si en el tope no hay ninguno (no pasa: la máscara
 * tiene al menos un día), devuelve el día siguiente.
 */
export function diaHabilSiguiente(
  fecha: string,
  cal: CalendarioLaboral = CALENDARIO_POR_OMISION,
): string {
  for (let i = 1; i <= TOPE_DE_DIAS; i++) {
    const dia = sumarDias(fecha, i);
    if (esDiaHabil(dia, cal)) return dia;
  }
  return sumarDias(fecha, 1);
}
