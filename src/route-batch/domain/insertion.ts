/**
 * Inserción de una parada en una hoja: la posición factible más barata. Sirve
 * para el pedido tardío que entra después del cierre, para la parada que agrega
 * el administrador y para repartir lo que quedó sin hoja en la propuesta del
 * día. Pura: no lee la base ni el reloj.
 *
 * «Más barata» es la que menos retrasa el fin de la hoja; «factible» es la que
 * deja todas las paradas dentro de su franja y el vehículo dentro de su
 * capacidad (kg y garrafas) y del máximo de paradas.
 */
import {
  computeSchedule,
  ScheduleScore,
  RouteStop,
  Schedule,
  ScheduleParams,
  scoreSchedule,
} from './eta';
import { InvalidRouteInputError } from './errors/route-sheet.errors';
import { assertValidStops } from './route-input';
import {
  fitsCapacity,
  LoadPoint,
  StopLoad,
  VehicleCapacity,
} from './load-profile';

// Alias: `Math.*` directo es varias veces más lento bajo Jest (contexto global del sandbox).
const { max } = Math;

const MS_POR_MINUTO = 60_000;

export interface CapacityContext extends VehicleCapacity {
  /** Carga de cada pedido de la hoja (y del candidato). */
  loads: ReadonlyMap<string, StopLoad>;
  /** Vacías con las que sale el vehículo, si la distribuidora las lleva. */
  initialEmpty?: LoadPoint;
}

export interface InsertionContext {
  schedule: ScheduleParams;
  /** Sin esto no hay tope de capacidad. */
  capacity?: CapacityContext;
  maxStops?: number;
}

export interface InsertionOptions {
  /** No se inserta antes de esta posición (la cola pendiente de una hoja en curso). */
  minPosition?: number;
  /** Posición elegida por el administrador: sólo se evalúa ésa. */
  position?: number;
  /**
   * Si no hay posición factible, elegir la que deja menos paradas tarde en vez
   * de rechazar (el administrador aceptó las paradas fuera de franja).
   */
  allowLate?: boolean;
  /** Permite correr de lugar las paradas fijadas (con `position` explícita se permite siempre). */
  ignoreLocks?: boolean;
}

export type InsertionFailure = 'window' | 'capacity' | 'max_stops';

export type InsertionResult =
  | {
      ok: true;
      /** Posición (0 = primera) donde queda la parada. */
      position: number;
      /** Minutos que se corre el fin de la hoja. */
      addedMinutes: number;
      addedKm: number;
      /** Quedó fuera de franja (sólo con `allowLate`). */
      late: boolean;
      schedule: Schedule;
      order: RouteStop[];
      /** Fijadas que cambian de lugar por esta inserción. */
      shiftedLocked: string[];
    }
  | { ok: false; reason: InsertionFailure };

function entraEnLaCapacidad(
  order: readonly RouteStop[],
  capacity: CapacityContext | undefined,
): boolean {
  if (!capacity) return true;
  return fitsCapacity(
    order.map((s) => s.id),
    capacity.loads,
    capacity,
    capacity.initialEmpty,
  );
}

export function bestInsertion(
  route: readonly RouteStop[],
  candidate: RouteStop,
  ctx: InsertionContext,
  options: InsertionOptions = {},
): InsertionResult {
  // La ruta ya viene validada (la armó el optimizador); sólo se mira la candidata.
  assertValidStops([candidate], ctx.schedule.matrix, ctx.schedule.originPoint);
  if (route.some((s) => s.id === candidate.id)) {
    throw new InvalidRouteInputError(
      `el pedido ${candidate.id} ya está en la hoja`,
    );
  }
  if (ctx.maxStops !== undefined && route.length >= ctx.maxStops) {
    return { ok: false, reason: 'max_stops' };
  }
  const base = scoreSchedule(route, ctx.schedule);

  const ultimaFijada = route.reduce((u, s, i) => (s.locked ? i : u), -1);
  let posiciones: number[];
  if (options.position !== undefined) {
    posiciones = [Math.min(max(options.position, 0), route.length)];
  } else {
    const desde = max(
      options.minPosition ?? 0,
      options.ignoreLocks ? 0 : ultimaFijada + 1,
    );
    posiciones = [];
    for (let p = desde; p <= route.length; p++) posiciones.push(p);
  }

  interface Candidata {
    position: number;
    order: RouteStop[];
    schedule: ScheduleScore;
  }
  const factibles: Candidata[] = [];
  const tardias: Candidata[] = [];
  let algunaEntraEnCapacidad = false;

  for (const position of posiciones) {
    const order = [
      ...route.slice(0, position),
      candidate,
      ...route.slice(position),
    ];
    if (!entraEnLaCapacidad(order, ctx.capacity)) continue;
    algunaEntraEnCapacidad = true;
    const schedule = scoreSchedule(order, ctx.schedule);
    // No cuenta como «tarde» lo que ya lo era antes de insertar.
    if (schedule.lateCount <= base.lateCount) {
      factibles.push({ position, order, schedule });
    } else {
      tardias.push({ position, order, schedule });
    }
  }

  const mejorDe = (lista: Candidata[], porTardias: boolean): Candidata =>
    [...lista].sort(
      (a, b) =>
        (porTardias ? a.schedule.lateCount - b.schedule.lateCount : 0) ||
        a.schedule.finishMs - b.schedule.finishMs ||
        a.schedule.totalKm - b.schedule.totalKm ||
        a.position - b.position,
    )[0];

  let elegida: Candidata | undefined;
  let late = false;
  if (factibles.length > 0) {
    elegida = mejorDe(factibles, false);
  } else if (options.allowLate && tardias.length > 0) {
    elegida = mejorDe(tardias, true);
    late = true;
  }
  if (!elegida) {
    return {
      ok: false,
      reason: algunaEntraEnCapacidad ? 'window' : 'capacity',
    };
  }

  const corridas = route
    .map((s, i) => ({ s, i }))
    .filter(({ s, i }) => s.locked && elegida.position <= i)
    .map(({ s }) => s.id);

  return {
    ok: true,
    position: elegida.position,
    addedMinutes: max(
      0,
      (elegida.schedule.finishMs - base.finishMs) / MS_POR_MINUTO,
    ),
    addedKm: max(0, elegida.schedule.totalKm - base.totalKm),
    late,
    schedule: computeSchedule(elegida.order, ctx.schedule),
    order: elegida.order,
    shiftedLocked: corridas,
  };
}
