/**
 * Armado de casos para los specs del dominio de la hoja de ruta: puntos en un
 * plano (km), una matriz euclidiana a velocidad fija y paradas con franja en
 * minutos desde las 08:00. No hay red ni reloj: los tiempos salen de cuentas
 * que se pueden hacer a mano.
 */
import { RouteStop, ScheduleParams } from './eta';
import { TravelMatrix } from './travel-matrix';

export const T0 = Date.UTC(2026, 10, 2, 11, 0, 0); // 08:00 hora argentina
export const MIN = 60_000;
export const KMH = 30;

export interface XY {
  x: number;
  y: number;
}

/** Matriz del plano: fila 0 = depósito. Distancia euclidiana a `KMH` km/h. */
export function matrixOf(points: readonly XY[], kmh = KMH): TravelMatrix {
  const km = points.map((a) =>
    points.map((b) => Math.hypot(a.x - b.x, a.y - b.y)),
  );
  return { km, minutes: km.map((fila) => fila.map((d) => (d / kmh) * 60)) };
}

/** Parada con la franja en minutos desde `T0`. */
export function stopAt(
  id: string,
  point: number,
  startMin: number,
  endMin: number,
  extra: Partial<RouteStop> = {},
): RouteStop {
  return {
    id,
    point,
    windowStartMs: T0 + startMin * MIN,
    windowEndMs: T0 + endMin * MIN,
    createdAtMs: T0 - 1000 * point,
    ...extra,
  };
}

export function scheduleParams(
  points: readonly XY[],
  extra: Partial<ScheduleParams> = {},
): ScheduleParams {
  return {
    matrix: matrixOf(points),
    originPoint: 0,
    startMs: T0,
    serviceMinutes: 10,
    ...extra,
  };
}

/** Generador pseudoaleatorio determinista (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Todas las permutaciones de una lista (para el óptimo de los casos chicos). */
export function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((x, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((r) => [
      x,
      ...r,
    ]),
  );
}
