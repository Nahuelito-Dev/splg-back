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

  if (ahora.getTime() > dueAt.getTime()) {
    return ExpirationStatus.EXPIRED;
  }

  const inicioDeAviso = new Date(dueAt.getTime());
  inicioDeAviso.setDate(inicioDeAviso.getDate() - leadTimeDaysDelPlan);

  if (ahora.getTime() >= inicioDeAviso.getTime()) {
    return ExpirationStatus.DUE_SOON;
  }

  return ExpirationStatus.CURRENT;
}

/** Cuántos días faltan (negativo si ya venció). `null` si `dueAt` es `null`. */
export function diasHastaElVencimiento(
  dueAt: Date | null,
  ahora: Date = new Date(),
): number | null {
  if (!dueAt) {
    return null;
  }
  const msPorDia = 24 * 60 * 60 * 1000;
  return Math.ceil((dueAt.getTime() - ahora.getTime()) / msPorDia);
}
