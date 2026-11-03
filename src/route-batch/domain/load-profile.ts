import { MissingStopLoadError } from './errors/route-sheet.errors';
// Alias: `Math.*` directo es varias veces más lento bajo Jest (contexto global del sandbox).
const { round, max } = Math;

/** La carga de un pedido: si falta es un error (no se asume que pesa cero). */
function cargaDe(loads: ReadonlyMap<string, StopLoad>, id: string): StopLoad {
  const l = loads.get(id);
  if (l === undefined) throw new MissingStopLoadError(id);
  return l;
}

/**
 * Perfil de carga de una hoja: cuántos kilos y cuántos envases lleva el
 * vehículo después de cada parada, y cuál es el pico. Con canje 1 a 1 las
 * unidades se mantienen (sale una llena, vuelve una vacía) y los retiros de
 * envases acordados (M5) las suben; los kilos bajan porque la llena pesa más
 * que la vacía.
 *
 *   unidades_k = unidades_{k-1} - entregadas_k + vacías_k + retiros_k
 *   kg_k       = kg_{k-1}       - entregados_k  + vacías_k + retiros_k
 *
 * El pico de kilos suele ser a la salida y el de unidades puede ser al final.
 * Se compara contra la capacidad del vehículo en cualquiera de los dos.
 */

/** Lo que mueve un pedido en su parada. Los kilos son los que pesa cada cosa en el camión. */
export interface StopLoad {
  /** Garrafas llenas que se entregan. */
  deliverUnits: number;
  deliverKg: number;
  /** Vacías que se levantan en el canje. */
  collectUnits: number;
  collectKg: number;
  /** Envases retirados al cliente por recupero (M5). */
  pickupUnits: number;
  pickupKg: number;
}

export const SIN_CARGA: StopLoad = {
  deliverUnits: 0,
  deliverKg: 0,
  collectUnits: 0,
  collectKg: 0,
  pickupUnits: 0,
  pickupKg: 0,
};

export interface LoadPoint {
  units: number;
  kg: number;
}

export interface LoadProfile {
  /** Lo que lleva al salir: todas las llenas (más las vacías que salga llevando). */
  departure: LoadPoint;
  afterStop: Array<LoadPoint & { id: string }>;
  peakUnits: number;
  peakKg: number;
  /** Garrafas llenas a cargar. */
  totalUnits: number;
  totalKg: number;
}

export interface VehicleCapacity {
  /** `null`: el vehículo no tiene capacidad cargada (sin tope). */
  capacityKg: number | null;
  capacityUnits: number | null;
}

const redondear = (n: number): number => round(n * 100) / 100;

export function buildLoadProfile(
  order: readonly string[],
  loads: ReadonlyMap<string, StopLoad>,
  initialEmpty: LoadPoint = { units: 0, kg: 0 },
): LoadProfile {
  const de = (id: string): StopLoad => cargaDe(loads, id);
  const totalUnits = order.reduce((t, id) => t + de(id).deliverUnits, 0);
  const totalKg = order.reduce((t, id) => t + de(id).deliverKg, 0);

  const departure = {
    units: totalUnits + initialEmpty.units,
    kg: redondear(totalKg + initialEmpty.kg),
  };
  let units = departure.units;
  let kg = departure.kg;
  let peakUnits = units;
  let peakKg = kg;
  const afterStop: LoadProfile['afterStop'] = [];

  for (const id of order) {
    const l = de(id);
    units += -l.deliverUnits + l.collectUnits + l.pickupUnits;
    kg = redondear(kg - l.deliverKg + l.collectKg + l.pickupKg);
    afterStop.push({ id, units, kg });
    peakUnits = max(peakUnits, units);
    peakKg = max(peakKg, kg);
  }
  return {
    departure,
    afterStop,
    peakUnits,
    peakKg,
    totalUnits,
    totalKg: redondear(totalKg),
  };
}

/** Sólo los picos de un orden, sin armar el detalle por parada (camino caliente). */
export function loadPeaks(
  order: readonly string[],
  loads: ReadonlyMap<string, StopLoad>,
  initialEmpty: LoadPoint = { units: 0, kg: 0 },
): { peakUnits: number; peakKg: number } {
  let units = initialEmpty.units;
  let kg = initialEmpty.kg;
  const cargas = order.map((id) => cargaDe(loads, id));
  for (const l of cargas) {
    units += l.deliverUnits;
    kg += l.deliverKg;
  }
  let peakUnits = units;
  let peakKg = redondear(kg);
  kg = peakKg;
  for (const l of cargas) {
    units += -l.deliverUnits + l.collectUnits + l.pickupUnits;
    kg = redondear(kg - l.deliverKg + l.collectKg + l.pickupKg);
    if (units > peakUnits) peakUnits = units;
    if (kg > peakKg) peakKg = kg;
  }
  return { peakUnits, peakKg };
}

/** ¿Entra el orden en el vehículo? Igual que `checkCapacity(buildLoadProfile(...))`, más barato. */
export function fitsCapacity(
  order: readonly string[],
  loads: ReadonlyMap<string, StopLoad>,
  capacity: VehicleCapacity,
  initialEmpty?: LoadPoint,
): boolean {
  const { peakUnits, peakKg } = loadPeaks(order, loads, initialEmpty);
  return (
    (capacity.capacityKg === null || peakKg <= capacity.capacityKg) &&
    (capacity.capacityUnits === null || peakUnits <= capacity.capacityUnits)
  );
}

export interface CapacityCheck {
  fits: boolean;
  kgExceeded: boolean;
  unitsExceeded: boolean;
  /** Primera parada (o `null` si es la salida) después de la cual se excede la capacidad. */
  firstExceededAfter: string | null;
}

export function checkCapacity(
  profile: LoadProfile,
  capacity: VehicleCapacity,
): CapacityCheck {
  const kgTope = capacity.capacityKg;
  const unidadesTope = capacity.capacityUnits;
  const sobra = (p: LoadPoint): boolean =>
    (kgTope !== null && p.kg > kgTope) ||
    (unidadesTope !== null && p.units > unidadesTope);

  const kgExceeded = kgTope !== null && profile.peakKg > kgTope;
  const unitsExceeded =
    unidadesTope !== null && profile.peakUnits > unidadesTope;
  let firstExceededAfter: string | null = null;
  if (kgExceeded || unitsExceeded) {
    if (!sobra(profile.departure)) {
      firstExceededAfter = profile.afterStop.find(sobra)?.id ?? null;
    }
  }
  return {
    fits: !kgExceeded && !unitsExceeded,
    kgExceeded,
    unitsExceeded,
    firstExceededAfter,
  };
}
