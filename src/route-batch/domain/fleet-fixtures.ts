/**
 * Armado de escenarios de flota para los specs de `planFleet`: pedidos en puntos del plano
 * (el depósito es la fila 0), vehículos y lectura de lo asignado.
 */
import {
  FleetOrder,
  FleetParams,
  FleetPlan,
  FleetVehicle,
} from './fleet-assignment';
import { SIN_CARGA, StopLoad } from './load-profile';
import { matrixOf, MIN, T0, XY } from './route-fixtures';

const DEPOSITO: XY = { x: 0, y: 0 };
export const CENTRO = { lat: 0, lng: 0 };

export const carga = (kg: number, units = 1): StopLoad => ({
  ...SIN_CARGA,
  deliverKg: kg,
  deliverUnits: units,
});

export interface PedidoSpec {
  id: string;
  at: XY | null;
  kg?: number;
  units?: number;
  window?: [number, number];
  load?: StopLoad;
}

/** Arma los pedidos y los parámetros desde puntos del plano (el depósito es la fila 0). */
export function escenario(
  pedidos: readonly PedidoSpec[],
  extra: Partial<FleetParams> = {},
) {
  const puntos: XY[] = [DEPOSITO];
  const orders: FleetOrder[] = pedidos.map((p, i) => {
    let point: number | null = null;
    if (p.at) {
      puntos.push(p.at);
      point = puntos.length - 1;
    }
    const [ini, fin] = p.window ?? [0, 100_000];
    return {
      id: p.id,
      point,
      lat: p.at ? p.at.y : null,
      lng: p.at ? p.at.x : null,
      windowStartMs: T0 + ini * MIN,
      windowEndMs: T0 + fin * MIN,
      createdAtMs: T0 - (i + 1) * 1000,
      load: p.load ?? carga(p.kg ?? 10, p.units ?? 1),
    };
  });
  const params: FleetParams = {
    schedule: {
      matrix: matrixOf(puntos),
      originPoint: 0,
      startMs: T0,
      serviceMinutes: 10,
    },
    depot: { lat: 0, lng: 0 },
    maxStopsPerSheet: 20,
    ...extra,
  };
  return { orders, params };
}

export const vehiculo = (
  id: string,
  capacityKg: number | null = null,
  capacityUnits: number | null = null,
): FleetVehicle => ({ id, capacityKg, capacityUnits });

export const asignados = (plan: FleetPlan): string[] =>
  plan.sheets.flatMap((s) => s.orderIds).sort();
