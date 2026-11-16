/**
 * Reparto de los pedidos de un día entre los vehículos (propuesta de las hojas).
 * VRP con franjas y capacidad, resuelto con heurísticas que se pueden explicar
 * con un dibujo. Pura y determinista: sin I/O ni reloj.
 *
 *  1. Barrido angular alrededor del depósito (Gillett–Miller): los pedidos se
 *     ordenan por ángulo, arrancando después del hueco angular más grande, y se
 *     llena un vehículo tras otro hasta su capacidad (kg y garrafas) o el máximo
 *     de paradas.
 *  2. Cada hoja se ordena con `optimizeStops` (vecino más cercano con franjas +
 *     2-opt / Or-opt). Lo que no llega en franja, o hace pasar al vehículo de su
 *     capacidad en algún tramo, vuelve al pozo.
 *  3. Lo del pozo se inserta donde menos retrasa (`bestInsertion`).
 *  4. Relocate entre hojas: se mueve una parada a otra hoja si baja el tiempo
 *     total y las dos quedan factibles y dentro de capacidad (tope fijo de
 *     iteraciones).
 *  5. Lo que no entra en ninguna queda sin asignar, con el motivo.
 */
import { InvalidRouteInputError } from './errors/route-sheet.errors';
import { assertValidCoordinates, assertValidStops } from './route-input';
import { RouteStop, Schedule, ScheduleParams, scoreSchedule } from './eta';
import { bestInsertion } from './insertion';
import {
  buildLoadProfile,
  fitsCapacity,
  LoadPoint,
  StopLoad,
  VehicleCapacity,
} from './load-profile';
import { optimizeStops } from './stop-optimizer';

// Alias: `Math.*` directo es varias veces más lento bajo Jest (contexto global del sandbox).
const { round } = Math;

const MS_POR_MINUTO = 60_000;

export interface FleetOrder {
  id: string;
  /** Fila en la matriz; `null` si el pedido no tiene punto de entrega. */
  point: number | null;
  lat: number | null;
  lng: number | null;
  windowStartMs: number;
  windowEndMs: number;
  createdAtMs: number;
  /** Lo que mueve el pedido en el camión; obligatorio (un pedido sin carga no pesa cero, es un error). */
  load: StopLoad;
}

export interface FleetVehicle extends VehicleCapacity {
  id: string;
}

export interface FleetParams {
  schedule: ScheduleParams;
  /** Coordenadas del depósito (centro del barrido). */
  depot: { lat: number; lng: number };
  maxStopsPerSheet: number;
  initialEmpty?: LoadPoint;
  /** Tope de movimientos del relocate (por omisión, dos por pedido). */
  maxRelocations?: number;
  /** Tope de nodos de la búsqueda de factibilidad de cada hoja (ver `optimizeStops`). */
  maxSearchNodes?: number;
}

export type UnassignedReason =
  | 'capacity'
  | 'window'
  | 'window_unverified'
  | 'no_point'
  | 'no_vehicles';

export interface UnassignedOrder {
  orderId: string;
  reason: UnassignedReason;
}

export interface PlannedSheet {
  vehicleId: string;
  orderIds: string[];
  stops: RouteStop[];
  schedule: Schedule;
  totalKg: number;
  totalUnits: number;
  peakKg: number;
  peakUnits: number;
}

export interface FleetPlan {
  sheets: PlannedSheet[];
  unassigned: UnassignedOrder[];
  /** Movimientos aceptados por el relocate. */
  relocations: number;
}

interface Hoja {
  vehicle: FleetVehicle;
  stops: RouteStop[];
}

const rotulo = (o: FleetOrder): RouteStop => ({
  id: o.id,
  point: o.point as number,
  windowStartMs: o.windowStartMs,
  windowEndMs: o.windowEndMs,
  createdAtMs: o.createdAtMs,
});

const anguloDe = (o: FleetOrder, depot: FleetParams['depot']): number =>
  Math.atan2((o.lat as number) - depot.lat, (o.lng as number) - depot.lng);

/** Orden del barrido: por ángulo, arrancando después del mayor hueco angular. */
export function sweepOrder(
  orders: readonly FleetOrder[],
  depot: FleetParams['depot'],
): FleetOrder[] {
  const conAngulo = orders
    .map((o) => ({ o, a: anguloDe(o, depot) }))
    .sort(
      (x, y) =>
        x.a - y.a ||
        x.o.windowStartMs - y.o.windowStartMs ||
        x.o.createdAtMs - y.o.createdAtMs ||
        x.o.id.localeCompare(y.o.id),
    );
  if (conAngulo.length < 2) return conAngulo.map((e) => e.o);

  let inicio = 0;
  let mayorHueco = -1;
  conAngulo.forEach((e, i) => {
    const siguiente = conAngulo[(i + 1) % conAngulo.length];
    const hueco =
      i === conAngulo.length - 1
        ? siguiente.a + 2 * Math.PI - e.a
        : siguiente.a - e.a;
    if (hueco > mayorHueco) {
      mayorHueco = hueco;
      inicio = (i + 1) % conAngulo.length;
    }
  });
  return [...conAngulo.slice(inicio), ...conAngulo.slice(0, inicio)].map(
    (e) => e.o,
  );
}

export function planFleet(
  orders: readonly FleetOrder[],
  vehiclesIn: readonly FleetVehicle[],
  params: FleetParams,
): FleetPlan {
  // El reparto no depende del orden en que llegan los vehículos.
  const vehicles = [...vehiclesIn].sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(vehicles.map((v) => v.id)).size !== vehicles.length) {
    throw new InvalidRouteInputError('hay vehículos repetidos');
  }
  for (const o of orders) assertValidCoordinates(o.id, o.lat, o.lng);
  const unassigned: UnassignedOrder[] = [];
  const cargas = new Map<string, StopLoad>(orders.map((o) => [o.id, o.load]));
  const porId = new Map(orders.map((o) => [o.id, o]));
  const { schedule: sch } = params;

  const sinPunto = (o: FleetOrder): boolean =>
    o.point === null || o.lat === null || o.lng === null;
  const conPunto = orders.filter((o) => !sinPunto(o));
  assertValidStops(
    conPunto.map(rotulo),
    params.schedule.matrix,
    params.schedule.originPoint,
  );
  if (new Set(orders.map((o) => o.id)).size !== orders.length) {
    throw new InvalidRouteInputError('hay pedidos repetidos');
  }
  for (const o of orders) {
    if (sinPunto(o)) unassigned.push({ orderId: o.id, reason: 'no_point' });
  }
  if (vehicles.length === 0) {
    for (const o of conPunto) {
      unassigned.push({ orderId: o.id, reason: 'no_vehicles' });
    }
    return {
      sheets: [],
      unassigned: ordenarSinAsignar(unassigned),
      relocations: 0,
    };
  }

  const capacidadDe = (v: FleetVehicle) => ({
    capacityKg: v.capacityKg,
    capacityUnits: v.capacityUnits,
    loads: cargas,
    initialEmpty: params.initialEmpty,
  });
  const entra = (v: FleetVehicle, stops: readonly RouteStop[]): boolean =>
    fitsCapacity(
      stops.map((s) => s.id),
      cargas,
      v,
      params.initialEmpty,
    );

  // Pozo: lo que todavía no tiene hoja, con el último motivo por el que no entró.
  const pozo = new Map<string, UnassignedReason>();
  // Lo que el optimizador no pudo probar que no entra en franja.
  const sinVerificar = new Set<string>();

  // 0. Un pedido que no llega en franja ni solo desde el depósito, o que no
  //    cabe solo en ningún vehículo, no entra al barrido.
  const barrible: FleetOrder[] = [];
  for (const o of conPunto) {
    const llegaSolo =
      sch.startMs +
        round(
          sch.matrix.minutes[sch.originPoint][o.point as number] *
            MS_POR_MINUTO,
        ) <=
      o.windowEndMs;
    if (!llegaSolo) {
      unassigned.push({ orderId: o.id, reason: 'window' });
    } else if (!vehicles.some((v) => entra(v, [rotulo(o)]))) {
      unassigned.push({ orderId: o.id, reason: 'capacity' });
    } else {
      barrible.push(o);
    }
  }

  // 1. Barrido.
  const hojas: Hoja[] = vehicles.map((vehicle) => ({ vehicle, stops: [] }));
  let actual = 0;
  const kgDe = (h: Hoja) =>
    h.stops.reduce((t, s) => t + (cargas.get(s.id)?.deliverKg ?? 0), 0);
  const unidadesDe = (h: Hoja) =>
    h.stops.reduce((t, s) => t + (cargas.get(s.id)?.deliverUnits ?? 0), 0);
  for (const o of sweepOrder(barrible, params.depot)) {
    const carga = o.load;
    let colocado = false;
    while (actual < hojas.length && !colocado) {
      const h = hojas[actual];
      const cabe =
        h.stops.length < params.maxStopsPerSheet &&
        (h.vehicle.capacityKg === null ||
          kgDe(h) + carga.deliverKg <= h.vehicle.capacityKg) &&
        (h.vehicle.capacityUnits === null ||
          unidadesDe(h) + carga.deliverUnits <= h.vehicle.capacityUnits);
      if (cabe) {
        h.stops.push(rotulo(o));
        colocado = true;
      } else {
        actual++;
      }
    }
    if (!colocado) pozo.set(o.id, 'capacity');
  }

  // 2. Ruteo de cada hoja; lo que sobra vuelve al pozo.
  for (const h of hojas) {
    if (h.stops.length === 0) continue;
    const r = optimizeStops(h.stops, sch, {
      accept: (orden) => entra(h.vehicle, orden),
      maxSearchNodes: params.maxSearchNodes,
    });
    h.stops = [...r.stops];
    for (const e of r.excluded) {
      pozo.set(e.id, e.reason === 'capacity' ? 'capacity' : 'window');
      if (e.reason === 'window_unverified') sinVerificar.add(e.id);
    }
    // Por si el pico de capacidad (que depende del orden) se pasa: se sacan las últimas.
    while (h.stops.length > 0 && !entra(h.vehicle, h.stops)) {
      const ultima = h.stops[h.stops.length - 1];
      h.stops = h.stops.slice(0, -1);
      pozo.set(ultima.id, 'capacity');
    }
  }

  // 3. Inserción de lo que quedó en el pozo, en la hoja donde menos retrasa.
  const pendientes = [...pozo.keys()]
    .map((id) => porId.get(id) as FleetOrder)
    .sort(
      (a, b) =>
        a.windowEndMs - b.windowEndMs ||
        a.createdAtMs - b.createdAtMs ||
        a.id.localeCompare(b.id),
    );
  for (const o of pendientes) {
    let mejor: {
      h: Hoja;
      r: Extract<ReturnType<typeof bestInsertion>, { ok: true }>;
    } | null = null;
    let porVentana = false;
    for (const h of hojas) {
      const r = bestInsertion(h.stops, rotulo(o), {
        schedule: sch,
        capacity: capacidadDe(h.vehicle),
        maxStops: params.maxStopsPerSheet,
      });
      if (r.ok) {
        if (!mejor || r.addedMinutes < mejor.r.addedMinutes) mejor = { h, r };
      } else if (r.reason === 'window') {
        porVentana = true;
      }
    }
    if (mejor) {
      mejor.h.stops = mejor.r.order;
      pozo.delete(o.id);
    } else {
      unassigned.push({
        orderId: o.id,
        reason: porVentana
          ? sinVerificar.has(o.id)
            ? 'window_unverified'
            : 'window'
          : 'capacity',
      });
      pozo.delete(o.id);
    }
  }

  // 4. Relocate entre hojas.
  const tope = params.maxRelocations ?? Math.max(2, orders.length * 2);
  let relocations = 0;
  const duracion = (stops: readonly RouteStop[]): number =>
    (scoreSchedule(stops, sch).finishMs - sch.startMs) / MS_POR_MINUTO;
  interface Movimiento {
    desde: Hoja;
    hacia: Hoja;
    nuevoDesde: RouteStop[];
    nuevoHacia: RouteStop[];
    ganancia: number;
  }
  while (relocations < tope) {
    let mover: Movimiento | null = null;
    for (const desde of hojas) {
      const durDesde = duracion(desde.stops);
      for (let i = 0; i < desde.stops.length; i++) {
        const parada = desde.stops[i];
        const nuevoDesde = desde.stops.filter((_, k) => k !== i);
        if (scoreSchedule(nuevoDesde, sch).lateCount > 0) continue;
        const ahorroDesde = durDesde - duracion(nuevoDesde);
        for (const hacia of hojas) {
          if (hacia === desde) continue;
          const r = bestInsertion(hacia.stops, parada, {
            schedule: sch,
            capacity: capacidadDe(hacia.vehicle),
            maxStops: params.maxStopsPerSheet,
          });
          if (!r.ok) continue;
          const ganancia = ahorroDesde - r.addedMinutes;
          if (
            ganancia > 1e-6 &&
            (mover === null || ganancia > mover.ganancia + 1e-9)
          ) {
            mover = { desde, hacia, nuevoDesde, nuevoHacia: r.order, ganancia };
          }
        }
      }
    }
    if (mover === null) break;
    const elegido: Movimiento = mover;
    elegido.desde.stops = elegido.nuevoDesde;
    elegido.hacia.stops = elegido.nuevoHacia;
    relocations++;
  }

  // 5. Resultado: re-optimizar cada hoja una última vez y armar el resumen.
  const sheets: PlannedSheet[] = [];
  for (const h of hojas) {
    if (h.stops.length === 0) continue;
    const r = optimizeStops(h.stops, sch, {
      lateStops: 'keep',
      accept: (orden) => entra(h.vehicle, orden),
    });
    const perfil = buildLoadProfile(r.order, cargas, params.initialEmpty);
    sheets.push({
      vehicleId: h.vehicle.id,
      orderIds: r.order,
      stops: r.stops,
      schedule: r.schedule,
      totalKg: perfil.totalKg,
      totalUnits: perfil.totalUnits,
      peakKg: perfil.peakKg,
      peakUnits: perfil.peakUnits,
    });
  }
  return { sheets, unassigned: ordenarSinAsignar(unassigned), relocations };
}

const ordenarSinAsignar = (l: UnassignedOrder[]): UnassignedOrder[] =>
  [...l].sort((a, b) => a.orderId.localeCompare(b.orderId));
