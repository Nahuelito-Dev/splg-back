/**
 * Reglas puras de la asistencia (CU-189, CU-313, CU-315). La jornada es un
 * registro de presencia: un ingreso y, si ya terminó, un egreso posterior.
 */
export type RechazoDeJornada = 'EGRESO_NO_POSTERIOR';

/** El egreso tiene que ser estrictamente posterior al ingreso. */
export function validarJornada(
  ingreso: Date,
  egreso: Date | null,
): RechazoDeJornada | null {
  if (egreso && egreso.getTime() <= ingreso.getTime()) {
    return 'EGRESO_NO_POSTERIOR';
  }
  return null;
}

/** Minutos entre el ingreso y el egreso (redondeado hacia abajo); `null` si sigue abierta. */
export function duracionEnMinutos(
  ingreso: Date,
  egreso: Date | null,
): number | null {
  if (!egreso) return null;
  return Math.floor((egreso.getTime() - ingreso.getTime()) / 60_000);
}

/** La nota de una corrección se suma a las anteriores: queda constancia de cada cambio. */
export function agregarNota(anterior: string | null, nueva: string): string {
  return anterior ? `${anterior}\n${nueva}` : nueva;
}
