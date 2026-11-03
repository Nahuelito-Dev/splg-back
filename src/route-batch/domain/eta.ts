/**
 * Hora estimada de llegada por parada (hoja de ruta). Funciones puras: no leen
 * la base ni el reloj.
 *
 *   eta_1 = max(salida + tramo(origen → 1), franja_1.inicio)
 *   eta_k = max(eta_{k-1} + servicio + tramo(k-1 → k), franja_k.inicio)
 *
 * Quien llega antes de que abra la franja espera; quien llega después de que
 * cierra está «tarde» (la parada sigue en la hoja, pero se marca).
 */
import { TravelMatrix } from './travel-matrix';

// Alias: `Math.*` directo es varias veces más lento bajo Jest (contexto global del sandbox).
const { round, max } = Math;

const MS_POR_MINUTO = 60_000;

/** Una parada tal como la ven el optimizador, la inserción y la ETA. */
export interface RouteStop {
  /** Id del pedido. */
  id: string;
  /** Fila de la parada en la matriz. */
  point: number;
  /** Franja comprada por el cliente, en milisegundos (instante real). */
  windowStartMs: number;
  windowEndMs: number;
  /** El administrador fijó la posición: el optimizador no la mueve. */
  locked?: boolean;
  /** Desempate determinista. */
  createdAtMs?: number;
}

export interface ScheduleParams {
  matrix: TravelMatrix;
  /** Fila de la matriz de donde sale el chofer (depósito o posición actual). */
  originPoint: number;
  /** Instante de salida (o «ahora» al recalcular en ruta). */
  startMs: number;
  serviceMinutes: number;
  /**
   * Primer tramo medido en vivo (posición del chofer → `stopId`), que reemplaza
   * al de la matriz sólo si esa parada queda primera: si el orden pone otra,
   * el tiempo medido no vale y se usa la matriz.
   */
  firstLeg?: { stopId: string; minutes: number; km: number };
}

export interface ScheduledStop {
  id: string;
  sequence: number;
  etaMs: number;
  /** Cuando termina de atender y sale hacia la siguiente. */
  departMs: number;
  /** Minutos de espera por llegar antes de que abra la franja. */
  waitMin: number;
  legMin: number;
  legKm: number;
  /** Llegaría después de que cierra su franja. */
  late: boolean;
  lateMin: number;
}

export interface Schedule {
  stops: ScheduledStop[];
  /** Cuando se termina de atender la última parada. */
  finishMs: number;
  totalKm: number;
  /** Minutos de manejo, sin esperas ni servicio. */
  travelMin: number;
  lateCount: number;
  /** Todas las paradas llegan dentro de su franja. */
  feasible: boolean;
}

/** Lo que importa para comparar dos órdenes, sin armar el detalle por parada. */
export interface ScheduleScore {
  finishMs: number;
  totalKm: number;
  lateCount: number;
}

/**
 * Recorre el orden calculando las horas. Es el único lugar donde se hace la
 * cuenta: `computeSchedule` la usa para el detalle y `scoreSchedule` (el camino
 * caliente del optimizador) para comparar sin armar objetos por parada.
 */
function walk(
  order: readonly RouteStop[],
  p: ScheduleParams,
  visit?: (stop: ScheduledStop) => void,
): ScheduleScore & { travelMin: number } {
  let clock = p.startMs;
  let at = p.originPoint;
  let totalKm = 0;
  let travelMin = 0;
  let lateCount = 0;
  const servicioMs = round(p.serviceMinutes * MS_POR_MINUTO);

  for (let i = 0; i < order.length; i++) {
    const s = order[i];
    const enVivo = i === 0 && p.firstLeg?.stopId === s.id ? p.firstLeg : null;
    const legMin = enVivo ? enVivo.minutes : p.matrix.minutes[at][s.point];
    const legKm = enVivo ? enVivo.km : p.matrix.km[at][s.point];
    const arrival = round(clock + legMin * MS_POR_MINUTO);
    const eta = max(arrival, s.windowStartMs);
    const lateMs = eta - s.windowEndMs;
    if (lateMs > 0) lateCount++;
    const depart = eta + servicioMs;
    visit?.({
      id: s.id,
      sequence: i + 1,
      etaMs: eta,
      departMs: depart,
      waitMin: (eta - arrival) / MS_POR_MINUTO,
      legMin,
      legKm,
      late: lateMs > 0,
      lateMin: lateMs > 0 ? lateMs / MS_POR_MINUTO : 0,
    });
    totalKm += legKm;
    travelMin += legMin;
    clock = depart;
    at = s.point;
  }
  return {
    finishMs: order.length > 0 ? clock : p.startMs,
    totalKm,
    travelMin,
    lateCount,
  };
}

export function computeSchedule(
  order: readonly RouteStop[],
  p: ScheduleParams,
): Schedule {
  const stops: ScheduledStop[] = [];
  const r = walk(order, p, (s) => stops.push(s));
  return {
    stops,
    finishMs: r.finishMs,
    totalKm: r.totalKm,
    travelMin: r.travelMin,
    lateCount: r.lateCount,
    feasible: r.lateCount === 0,
  };
}

export function scoreSchedule(
  order: readonly RouteStop[],
  p: ScheduleParams,
): ScheduleScore {
  const { finishMs, totalKm, lateCount } = walk(order, p);
  return { finishMs, totalKm, lateCount };
}

export interface EtaWindow {
  startMs: number;
  endMs: number;
  /** La hora estimada ya cayó fuera de la franja comprada. */
  outsideSlot: boolean;
}

/**
 * La franja que se le comunica al cliente: `[eta - w, eta + w]` recortada a la
 * franja comprada cuando cabe (nunca se le promete fuera de lo que compró). Si
 * la ETA ya se fue de la franja se le dice la verdad —la franja sin recortar— y
 * se marca `outsideSlot` para avisar al administrador.
 */
export function estimatedWindow(
  etaMs: number,
  slotStartMs: number,
  slotEndMs: number,
  halfWidthMinutes: number,
): EtaWindow {
  const w = halfWidthMinutes * MS_POR_MINUTO;
  const outsideSlot = etaMs < slotStartMs || etaMs > slotEndMs;
  if (outsideSlot) {
    return { startMs: etaMs - w, endMs: etaMs + w, outsideSlot };
  }
  return {
    startMs: max(etaMs - w, slotStartMs),
    endMs: Math.min(etaMs + w, slotEndMs),
    outsideSlot,
  };
}

/** Lo último que se le avisó al cliente de un pedido. */
export interface NotifiedWindow {
  startMs: number;
  endMs: number;
  notifiedAtMs: number;
}

export type NotifyReason = 'first' | 'shifted' | 'outside_slot';

export interface NotifyDecision {
  notify: boolean;
  reason: NotifyReason | null;
}

/** Mínimo entre dos avisos al mismo cliente por el mismo pedido. */
export const MINUTOS_ENTRE_AVISOS = 10;

/**
 * ¿Hay que avisarle al cliente su franja nueva? El primer aviso sale siempre;
 * después, sólo si la franja se corrió `shiftMinutes` o más (en cualquiera de
 * sus extremos) o si la hora estimada acaba de salir de la franja comprada, y
 * nunca dos avisos con menos de `MINUTOS_ENTRE_AVISOS` de diferencia. Se compara
 * la franja y no la hora puntual porque la franja es lo único que el cliente
 * ve: una ETA que se mueve dentro del recorte no cambia nada para él.
 */
export function notificationFor(
  window: EtaWindow,
  notified: NotifiedWindow | null,
  slot: { startMs: number; endMs: number },
  nowMs: number,
  shiftMinutes: number,
  minGapMinutes: number = MINUTOS_ENTRE_AVISOS,
): NotifyDecision {
  if (!notified) return { notify: true, reason: 'first' };
  if (nowMs - notified.notifiedAtMs < minGapMinutes * MS_POR_MINUTO) {
    return { notify: false, reason: null };
  }
  const antesFuera =
    notified.startMs < slot.startMs || notified.endMs > slot.endMs;
  if (window.outsideSlot && !antesFuera) {
    return { notify: true, reason: 'outside_slot' };
  }
  const corrimiento = max(
    Math.abs(window.startMs - notified.startMs),
    Math.abs(window.endMs - notified.endMs),
  );
  if (corrimiento >= shiftMinutes * MS_POR_MINUTO) {
    return { notify: true, reason: 'shifted' };
  }
  return { notify: false, reason: null };
}
