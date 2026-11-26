/**
 * Armado de casos para los specs de `application/`: pedidos del día con punto y
 * franja, hojas y paradas como las deja la base, y la calculadora real sobre la
 * matriz en línea recta (sin red). Sin jest: los dobles los arma cada spec.
 */
import {
  RouteBatch,
  RouteOptimizationMethod,
  RouteProposedBy,
} from '../../order/entities/route-batch.entity';
import { RouteBatchStop } from '../../order/entities/route-batch-stop.entity';
import {
  RoutePlan,
  RoutePlanStatus,
} from '../../order/entities/route-plan.entity';
import {
  haversineDurationsTo,
  haversineMatrix,
} from '../../routes/route-matrix';
import { RouteMatrixPort } from '../../routes/route-matrix.port';
import { RouteBatchKind, RouteBatchStatus } from '../domain/route-batch.enums';
import { instanteDelDia } from '../domain/route-sheet-rules';
import { RouteSheetCalculator } from './route-sheet-calculator.service';
import { RouteSheetDto } from '../presentation/dto/route-sheet-response.dto';
import { PedidoDeHoja } from './route-sheet-data.service';

export const DIST = 'dist-1';
export const DIA = '2026-11-14';
/** Posadas: los pedidos se reparten a unos cientos de metros del depósito. */
export const DEPOSITO = { warehouseId: 'dep-1', lat: -27.37, lng: -55.9 };
export const PARAMS = {
  serviceMinutes: 10,
  trafficFactor: 1,
  maxStopsPerSheet: 20,
};

export function pedido(
  orderId: string,
  over: Partial<PedidoDeHoja> = {},
): PedidoDeHoja {
  const i = Number(orderId.replace(/\D/g, '')) || 1;
  return {
    orderId,
    status: 'pending',
    deliveryId: null,
    scheduledDate: DIA,
    hasSlot: true,
    deliveryMode: 'standard',
    depositPaid: false,
    fraudHold: false,
    hasPoint: true,
    lat: DEPOSITO.lat + i * 0.003,
    lng: DEPOSITO.lng + i * 0.002,
    slotStartMs: instanteDelDia(DIA, '08:00'),
    slotEndMs: instanteDelDia(DIA, '20:00'),
    slotName: 'Todo el día',
    fixedSlot: true,
    dayStartMs: instanteDelDia(DIA, '08:00'),
    dayEndMs: instanteDelDia(DIA, '20:00'),
    createdAtMs: instanteDelDia(DIA, '00:00') - 86_400_000,
    customerName: `Cliente ${i}`,
    customerPhone: `376400000${i}`,
    address: `Calle ${i}`,
    units: 1,
    weightKg: 10,
    collectUnits: 1,
    unpaidOnline: false,
    cashToCollect: null,
    offeredNow: false,
    activeBatchId: null,
    ...over,
  };
}

export function hoja(over: Partial<RouteBatch> = {}): RouteBatch {
  return Object.assign(new RouteBatch(), {
    batchId: 'hoja-1',
    distributorId: DIST,
    kind: RouteBatchKind.PLANNED,
    status: RouteBatchStatus.DRAFT,
    planDate: DIA,
    number: null,
    deliveryId: 'chofer-1',
    carId: 'auto-1',
    originWarehouseId: DEPOSITO.warehouseId,
    plannedStartAt: null,
    totalWeightKg: 0,
    totalDistanceKm: null,
    totalDurationMin: null,
    totalUnits: null,
    peakUnits: null,
    optimizationMethod: RouteOptimizationMethod.NN_2OPT,
    matrixSource: null,
    proposedBy: RouteProposedBy.SYSTEM,
    editedAt: null,
    confirmedAt: null,
    confirmedByUserId: null,
    closedAt: null,
    closeReason: null,
    createdAt: new Date('2026-11-13T12:00:00Z'),
    version: 3,
    ...over,
  });
}

export function parada(
  orderId: string,
  sequence: number,
  over: Partial<RouteBatchStop> = {},
): RouteBatchStop {
  return Object.assign(new RouteBatchStop(), {
    stopId: `s-${orderId}`,
    batchId: 'hoja-1',
    orderId,
    sequence,
    active: true,
    sequenceLocked: false,
    etaAt: null,
    plannedEtaAt: null,
    legDistanceKm: 0,
    legDurationMin: null,
    removedReason: null,
    removedAt: null,
    ...over,
  });
}

export function plan(over: Partial<RoutePlan> = {}): RoutePlan {
  return Object.assign(new RoutePlan(), {
    planId: 'plan-1',
    distributorId: DIST,
    planDate: DIA,
    status: RoutePlanStatus.OPEN,
    cutoffAt: new Date('2026-11-13T21:00:00Z'),
    proposedAt: null,
    proposalSummary: null,
    closedAt: null,
    closedByUserId: null,
    ...over,
  });
}

/** La calculadora real con la matriz en línea recta. */
export function calculadora(): RouteSheetCalculator {
  const port: RouteMatrixPort = {
    matrix: (p) => Promise.resolve(haversineMatrix(p)),
    durationsTo: (o, d) => Promise.resolve(haversineDurationsTo(o, d)),
  };
  return new RouteSheetCalculator(port);
}

/** Una hoja como la devuelve la API (para el PDF y los controladores). */
export function hojaDto(over: Partial<RouteSheetDto> = {}): RouteSheetDto {
  return {
    id: 'hoja-1',
    number: 12,
    planDate: DIA,
    status: RouteBatchStatus.CONFIRMED,
    version: 4,
    deliveryId: 'chofer-1',
    driverName: 'Juan Chofer',
    carId: 'auto-1',
    carPatent: 'AB123CD',
    originWarehouseId: DEPOSITO.warehouseId,
    plannedStartAt: '2026-11-14T10:30:00.000Z',
    proposedBy: RouteProposedBy.SYSTEM,
    optimizationMethod: RouteOptimizationMethod.NN_2OPT,
    matrixSource: null,
    editedAt: null,
    confirmedAt: '2026-11-13T22:00:00.000Z',
    closedAt: null,
    closeReason: null,
    totals: {
      distanceKm: 12.5,
      durationMin: 95,
      units: 3,
      peakUnits: 3,
      weightKg: 30,
      emptiesExpected: 2,
    },
    capacity: { kg: 500, units: 20 },
    stops: [
      {
        orderId: 'o1',
        sequence: 1,
        locked: false,
        customerName: 'Ana Gómez',
        customerPhone: '3764000001',
        address: 'Calle 1',
        lat: -27.37,
        lng: -55.9,
        slotName: 'Mañana',
        slotStart: '2026-11-14T11:00:00.000Z',
        slotEnd: '2026-11-14T15:00:00.000Z',
        etaAt: '2026-11-14T11:20:00.000Z',
        plannedEtaAt: '2026-11-14T11:20:00.000Z',
        legDistanceKm: 2,
        legDurationMin: 6,
        late: false,
        units: 2,
        emptiesExpected: 2,
        weightKg: 20,
        unpaidOnline: false,
        cashToCollect: null,
      },
    ],
    warnings: [],
    ...over,
  } as RouteSheetDto;
}
