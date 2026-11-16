/**
 * Estado de un vencimiento (CU-136 a CU-139), derivado de la fecha límite y de
 * la anticipación de su plan. Es un cálculo puro: no depende de TypeORM ni de
 * Nest, así que se prueba sin levantar nada.
 *
 * Distinto del `status` de `MaintenanceTask` (ciclo de vida: programada, en
 * curso, hecha, cancelada): este es "qué tan cerca está de la fecha límite",
 * y sólo tiene sentido mientras la tarea sigue abierta.
 */
export enum ExpirationStatus {
  /** Falta más que el `lead_time_days` del plan: no requiere acción todavía. */
  CURRENT = 'current',
  /** Dentro de la ventana de anticipación, pero todavía no venció. */
  DUE_SOON = 'due_soon',
  /** La fecha límite ya pasó. */
  EXPIRED = 'expired',
}

/**
 * Argentina no tiene horario de verano desde 2009: el desfasaje contra UTC es
 * siempre -3, todo el año. Si el país volviera a tener DST, esto deja de ser
 * válido — hoy alcanza con la constante.
 */
const HORAS_DE_DESFASAJE_ARGENTINA = 3;

/**
 * El instante en que deja de estar vigente el documento cuya fecha límite es
 * `dueAt`. `dueAt` guarda la medianoche UTC de la fecha calendario tal como
 * la cargó el administrador (ver `FleetDispatchLockService.formatearFechaUtc`,
 * que lee esos mismos componentes UTC para mostrarla): un documento "vence el
 * 31/12" tiene que seguir vigente hasta terminar el 31/12 EN HORA ARGENTINA
 * (America/Argentina/Buenos_Aires), no hasta las 00:00 UTC de ese día — que
 * son las 21:00 del 30/12 en Argentina, un día antes de lo que dice el
 * documento. El fin del día 31/12 en Argentina es el 1/1 00:00 ART, que en
 * UTC es el 1/1 03:00: un día completo más el desfasaje de 3 horas.
 */
export function finDeVigenciaEnArgentina(dueAt: Date): Date {
  const unDiaEnMs = 24 * 60 * 60 * 1000;
  const desfasajeEnMs = HORAS_DE_DESFASAJE_ARGENTINA * 60 * 60 * 1000;
  return new Date(dueAt.getTime() + unDiaEnMs + desfasajeEnMs);
}

/**
 * Calcula el estado de vencimiento de una fecha límite.
 *
 * @param dueAt fecha límite (vencimiento de la póliza, la VTV, la licencia).
 *   `null` si el plan no es por fecha fija (p. ej. un service por km sin
 *   fecha estimada todavía): en ese caso no hay estado que calcular.
 * @param leadTimeDaysDelPlan con cuántos días de anticipación el plan avisa.
 * @param ahora inyectable para tests; por defecto `new Date()`.
 */
export function calcularEstadoDeVencimiento(
  dueAt: Date | null,
  leadTimeDaysDelPlan: number,
  ahora: Date = new Date(),
): ExpirationStatus | null {
  if (!dueAt) {
    return null;
  }

  if (ahora.getTime() >= finDeVigenciaEnArgentina(dueAt).getTime()) {
    return ExpirationStatus.EXPIRED;
  }

  const inicioDeAviso = new Date(dueAt.getTime());
  inicioDeAviso.setDate(inicioDeAviso.getDate() - leadTimeDaysDelPlan);

  if (ahora.getTime() >= inicioDeAviso.getTime()) {
    return ExpirationStatus.DUE_SOON;
  }

  return ExpirationStatus.CURRENT;
}

/**
 * Cuántos días faltan hasta que el documento deje de estar vigente (negativo
 * si ya venció). `null` si `dueAt` es `null`.
 *
 * Mide contra el mismo instante que usa `calcularEstadoDeVencimiento`
 * (`finDeVigenciaEnArgentina`), no contra `dueAt` crudo: si no, esta cuenta y
 * el estado ("vencido"/"por vencer") podían contradecirse cerca del límite —
 * por ejemplo, mostrar "venció hace 1 día" cuando el estado todavía decía
 * `due_soon` porque en hora argentina no había terminado el día.
 */
export function diasHastaElVencimiento(
  dueAt: Date | null,
  ahora: Date = new Date(),
): number | null {
  if (!dueAt) {
    return null;
  }
  const msPorDia = 24 * 60 * 60 * 1000;
  return Math.ceil(
    (finDeVigenciaEnArgentina(dueAt).getTime() - ahora.getTime()) / msPorDia,
  );
}
