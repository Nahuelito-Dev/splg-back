import { Injectable } from '@nestjs/common';
import { RouteMatrixPort } from '../../routes/route-matrix.port';
import { RouteStop, ScheduleParams } from '../domain/eta';
import { StopLoad } from '../domain/load-profile';
import { MatrixSource, applyTrafficFactor } from '../domain/travel-matrix';
import {
  Deposito,
  PedidoDeHoja,
  cargaDelPedido,
} from './route-sheet-data.service';

/** Parámetros de `route_planning` que usa el cálculo. */
export interface ParametrosDeRuteo {
  serviceMinutes: number;
  trafficFactor: number;
  maxStopsPerSheet: number;
}

export interface Escenario {
  /** Una parada por pedido con punto y franja, en el orden recibido. */
  stops: RouteStop[];
  loads: Map<string, StopLoad>;
  schedule: ScheduleParams;
  source: MatrixSource;
  /** El origen: el depósito o, sin depósito ubicado, el centro de las paradas. */
  origin: { lat: number; lng: number; fromWarehouse: boolean };
}

/**
 * Arma lo que necesitan los algoritmos de E2 para un conjunto de pedidos: la
 * matriz (OSRM o línea recta, con el factor de tránsito), las paradas y sus
 * cargas. El punto 0 de la matriz es el origen.
 */
@Injectable()
export class RouteSheetCalculator {
  constructor(private readonly matrices: RouteMatrixPort) {}

  async escenario(
    pedidos: readonly PedidoDeHoja[],
    deposito: Deposito | null,
    startMs: number,
    p: ParametrosDeRuteo,
    locked: ReadonlySet<string> = new Set(),
  ): Promise<Escenario> {
    const conPunto = pedidos.filter(
      (o) =>
        o.lat !== null &&
        o.lng !== null &&
        o.slotStartMs !== null &&
        o.slotEndMs !== null,
    );
    const origin = deposito
      ? { lat: deposito.lat, lng: deposito.lng, fromWarehouse: true }
      : centro(conPunto);
    const puntos = [
      { lat: origin.lat, lng: origin.lng },
      ...conPunto.map((o) => ({ lat: o.lat as number, lng: o.lng as number })),
    ];
    const m = await this.matrices.matrix(puntos);
    const matrix = applyTrafficFactor(
      { minutes: m.minutes, km: m.km },
      p.trafficFactor,
      m.source,
    );
    return {
      stops: conPunto.map((o, i) => ({
        id: o.orderId,
        point: i + 1,
        windowStartMs: o.slotStartMs as number,
        windowEndMs: o.slotEndMs as number,
        createdAtMs: o.createdAtMs,
        locked: locked.has(o.orderId),
      })),
      loads: new Map(pedidos.map((o) => [o.orderId, cargaDelPedido(o)])),
      schedule: {
        matrix,
        originPoint: 0,
        startMs,
        serviceMinutes: p.serviceMinutes,
      },
      source: m.source,
      origin,
    };
  }
}

/** Sin depósito ubicado, el recorrido sale del centro de las paradas (el panel lo advierte). */
function centro(pedidos: readonly PedidoDeHoja[]): {
  lat: number;
  lng: number;
  fromWarehouse: boolean;
} {
  if (pedidos.length === 0) return { lat: 0, lng: 0, fromWarehouse: false };
  const lat =
    pedidos.reduce((t, o) => t + (o.lat as number), 0) / pedidos.length;
  const lng =
    pedidos.reduce((t, o) => t + (o.lng as number), 0) / pedidos.length;
  return { lat, lng, fromWarehouse: false };
}
