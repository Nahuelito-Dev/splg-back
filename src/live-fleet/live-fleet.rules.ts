import { progresoDeParada } from '../route-batch/domain/route-sheet-execution';

/** Estado del vehículo en la calle: con un viaje en curso o esperando. */
export type LiveVehicleStatus = 'on_route' | 'waiting';

/** Avance de una parada visible en el seguimiento. */
export type LiveStopProgress =
  | 'pending'
  | 'on_the_way'
  | 'delivered'
  | 'failed';

export interface ParadaDeHoja {
  orderId: string;
  sequence: number;
  active: boolean;
  removedReason: string | null;
  removedAt: Date | null;
  etaAt: Date | null;
  orderStatus: string | null;
}

export interface ParadaEnVivo {
  orderId: string;
  /** Orden en la hoja; `null` si salió de la hoja o es un pedido suelto. */
  sequence: number | null;
  progress: LiveStopProgress;
  etaAt: Date | null;
}

/**
 * Qué paradas de la hoja se muestran y con qué avance. Antes de iniciar sólo
 * cuentan las activas; después, también las que se entregaron o fallaron en la
 * calle. Las que salieron por otro motivo (canceladas, movidas) no se listan.
 * Primero las activas en su orden; después las que ya salieron.
 */
export function paradasEnVivo(
  paradas: readonly ParadaDeHoja[],
  inicio: Date | null,
): ParadaEnVivo[] {
  const visibles: ParadaEnVivo[] = [];
  for (const p of paradas) {
    const enLaCalle =
      inicio !== null &&
      (p.removedReason === null || (!!p.removedAt && p.removedAt >= inicio));
    if (!p.active && !enLaCalle) continue;
    const progress = progresoDeParada(p, p.orderStatus);
    if (progress === 'removed') continue;
    visibles.push({
      orderId: p.orderId,
      sequence: p.active ? p.sequence : null,
      progress,
      etaAt: p.etaAt,
    });
  }
  return visibles.sort(
    (a, b) =>
      Number(b.sequence !== null) - Number(a.sequence !== null) ||
      (a.sequence ?? 0) - (b.sequence ?? 0),
  );
}

export interface AvanceDeHoja {
  total: number;
  delivered: number;
  failed: number;
  pending: number;
}

/** Cuántas paradas hay, cuántas se entregaron, cuántas fallaron y cuántas faltan (pendientes más la que está en camino). */
export function avance(
  paradas: ReadonlyArray<{ progress: LiveStopProgress }>,
): AvanceDeHoja {
  const contar = (...estados: LiveStopProgress[]) =>
    paradas.filter((p) => estados.includes(p.progress)).length;
  return {
    total: paradas.length,
    delivered: contar('delivered'),
    failed: contar('failed'),
    pending: contar('pending', 'on_the_way'),
  };
}

/** Llegada estimada a la última parada que falta: cuándo termina el recorrido. `null` sin paradas pendientes con hora. */
export function finEstimado(
  paradas: ReadonlyArray<{ progress: LiveStopProgress; etaAt: Date | null }>,
): Date | null {
  let fin: Date | null = null;
  for (const p of paradas) {
    if (p.progress !== 'pending' && p.progress !== 'on_the_way') continue;
    if (p.etaAt && (fin === null || p.etaAt > fin)) fin = p.etaAt;
  }
  return fin;
}

/**
 * Ocupación del vehículo: envases a bordo (llenos, vacíos y defectuosos, que
 * ocupan el mismo lugar) sobre las garrafas que entran. `null` si el vehículo
 * no tiene la capacidad cargada. Puede pasar de 100 si va excedido.
 */
export function porcentajeDeCarga(
  aBordo: number,
  capacidad: number | null,
): number | null {
  if (capacidad === null || capacidad <= 0) return null;
  return Math.round((aBordo * 100) / capacidad);
}

/** En ruta si la hoja ya se inició o tiene un pedido aceptado o en camino; si no, esperando. */
export function estadoDelVehiculo(
  hojaIniciada: boolean,
  pedidosEnCurso: number,
): LiveVehicleStatus {
  return hojaIniciada || pedidosEnCurso > 0 ? 'on_route' : 'waiting';
}
