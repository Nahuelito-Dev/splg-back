import { diaArgentino, diasEntre } from '../../../common/utils/dias-argentina';

/** Días mínimos entre el pronóstico y el cierre para medir el ritmo real de uso. */
export const DIAS_MINIMOS_PARA_MEDIR = 7;

/** Cierres mínimos de un vehículo y tipo de tarea para que su desvío corrija la proyección. */
export const CIERRES_MINIMOS_PARA_CALIBRAR = 3;

/** De dónde sale la corrección: el historial de cierres del mismo vehículo y tipo de tarea. */
export type FuenteDeLaCorreccion = 'vehicle_task_type';

/** Lo que se le aplicó a una proyección por el desvío histórico del vehículo. */
export interface CorreccionDeVencimiento {
  /** Días que se sumaron a la fecha proyectada por kilometraje (negativo = se adelantó). */
  correctionDays: number;
  /** Desvío medio de los cierres promediados, con signo (positivo = se hizo después de lo proyectado). */
  averageDeviationDays: number;
  /** Cierres promediados. */
  samples: number;
  /** El desvío medio superaba el tope y la corrección quedó en el tope. */
  capped: boolean;
  source: FuenteDeLaCorreccion;
}

export interface ParametrosDeCalibracion {
  /** Cuántos de los últimos cierres se promedian. */
  cierres: number;
  /** Tope de la corrección, en días, en uno y otro sentido (0 la desactiva). */
  topeDias: number;
}

/**
 * Corrección que sale de los desvíos de los cierres de un vehículo y tipo de
 * tarea (el más reciente primero): el promedio de los últimos `cierres`,
 * redondeado al día y acotado a `±topeDias`. Con menos de tres cierres, o con
 * el tope en 0, no hay corrección.
 */
export function calcularCorreccion(
  desviosRecientesPrimero: readonly number[],
  { cierres, topeDias }: ParametrosDeCalibracion,
): CorreccionDeVencimiento | null {
  if (topeDias <= 0) return null;
  const usados = desviosRecientesPrimero.slice(0, Math.max(1, cierres));
  if (usados.length < CIERRES_MINIMOS_PARA_CALIBRAR) return null;
  const promedio = usados.reduce((a, d) => a + d, 0) / usados.length;
  const tope = Math.round(topeDias);
  const correccion = Math.max(-tope, Math.min(tope, Math.round(promedio)));
  return {
    correctionDays: correccion,
    averageDeviationDays: Math.round(promedio * 100) / 100,
    samples: usados.length,
    capped: Math.abs(Math.round(promedio)) > tope,
    source: 'vehicle_task_type',
  };
}

export interface MedicionDelPronostico {
  /** La primera fecha proyectada por kilometraje, sin corregir. */
  primeraFecha: Date;
  /** Cuándo se hizo esa primera proyección y con qué kilometraje del vehículo. */
  pronosticadaEn: Date;
  odometroAlPronosticar: number;
  /** Kilometraje al que vence la tarea. */
  dueKm: number;
  /** Vencimiento por fecha fija de la tarea, si lo tiene. */
  dueAt: Date | null;
  /** Cuándo se cerró la tarea y el kilometraje que se asentó en el cierre. */
  cerradaEn: Date;
  odometroAlCerrar: number;
}

/**
 * Cuánto se equivocó el pronóstico de USO de un vehículo, en días de calendario:
 * cuándo habría llegado a `dueKm` con el ritmo real (el que midió el odómetro entre
 * el pronóstico y el cierre) menos cuándo lo pronosticó el sistema. Positivo: el
 * vehículo anda menos de lo estimado y llega después.
 *
 * No depende de cuándo se hizo el taller: una ventana adelantada o atrasada no
 * mueve el resultado, así que la corrección no se realimenta con el sesgo de las
 * ventanas. `null` (no se mide) si mandó la fecha fija, si el pronóstico ya estaba
 * vencido por kilometraje, si pasó menos de `DIAS_MINIMOS_PARA_MEDIR` días o si el
 * odómetro no avanzó.
 */
export function desvioDelPronostico(m: MedicionDelPronostico): number | null {
  if (m.dueAt && m.dueAt.getTime() <= m.primeraFecha.getTime()) return null;
  const restantes = m.dueKm - m.odometroAlPronosticar;
  const recorridos = m.odometroAlCerrar - m.odometroAlPronosticar;
  if (restantes <= 0 || recorridos <= 0) return null;
  const transcurridos = diasEntre(
    diaArgentino(m.pronosticadaEn),
    diaArgentino(m.cerradaEn),
  );
  if (transcurridos < DIAS_MINIMOS_PARA_MEDIR) return null;
  const ritmoReal = recorridos / transcurridos;
  const diasReales = Math.ceil(restantes / ritmoReal);
  const diasPronosticados = diasEntre(
    diaArgentino(m.pronosticadaEn),
    diaArgentino(m.primeraFecha),
  );
  return diasReales - diasPronosticados;
}
