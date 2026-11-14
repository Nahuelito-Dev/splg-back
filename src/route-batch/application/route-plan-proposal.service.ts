import { Injectable } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { ConfigurableProcess } from '../../distributor/entities/module-config.entity';
import { ProcessConfigService } from '../../distributor/process-config.service';
import {
  RouteBatch,
  RouteBatchCloseReason,
  RouteOptimizationMethod,
  RouteProposedBy,
} from '../../order/entities/route-batch.entity';
import {
  RoutePlan,
  RoutePlanStatus,
} from '../../order/entities/route-plan.entity';
import { RedisService } from '../../redis/redis.service';
import {
  FleetOrder,
  FleetVehicle,
  UnassignedReason,
  planFleet,
} from '../domain/fleet-assignment';
import { RouteBatchKind, RouteBatchStatus } from '../domain/route-batch.enums';
import {
  motivoNoPlanificable,
  salidaPorOmision,
} from '../domain/route-sheet-rules';
import { assertTransition } from '../domain/route-sheet.machine';
import { RoutePlanService } from './route-plan.service';
import { RouteSheetCalculator } from './route-sheet-calculator.service';
import {
  ChoferDelDia,
  RouteSheetDataService,
  VehiculoDelDia,
} from './route-sheet-data.service';
import { RouteSheetWriter } from './route-sheet-writer.service';
import {
  planCerrado,
  planOcupado,
  planificacionApagada,
} from './route-sheet.exceptions';

/** Por qué un pedido del día quedó fuera de la propuesta. */
export type MotivoSinHoja =
  | UnassignedReason
  | 'not_plannable'
  | 'dispatch_offer'
  | 'in_route';

export interface HojaPropuesta {
  /** `null` en una corrida de prueba (`dryRun`). */
  sheetId: string | null;
  deliveryId: string;
  carId: string;
  orderIds: string[];
  distanceKm: number;
  durationMin: number;
  units: number;
  peakUnits: number;
  weightKg: number;
}

export interface ResultadoDePropuesta {
  dryRun: boolean;
  candidates: number;
  matrixSource: string;
  sheets: HojaPropuesta[];
  unassigned: Array<{ orderId: string; reason: MotivoSinHoja }>;
  /** Hojas que se conservaron (confirmadas o tocadas a mano). */
  keptSheetIds: string[];
}

const CERROJO_TTL_MS = 5 * 60_000;

/**
 * La propuesta del día (§6.4 y §7.2): reparte los pedidos de D entre los pares
 * chofer–vehículo libres con los algoritmos de E2 (barrido + inserción +
 * 2-opt/Or-opt + relocate) y crea las hojas en borrador. Re-proponer rehace sólo
 * los borradores del sistema sin ediciones; las confirmadas y las tocadas a mano
 * no se pisan ni se mueven sus pedidos.
 */
@Injectable()
export class RoutePlanProposalService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly plans: RoutePlanService,
    private readonly data: RouteSheetDataService,
    private readonly calc: RouteSheetCalculator,
    private readonly writer: RouteSheetWriter,
    private readonly processConfig: ProcessConfigService,
    private readonly redis: RedisService,
  ) {}

  async proponer(
    distributorId: string,
    planDate: string,
    dryRun = false,
  ): Promise<ResultadoDePropuesta> {
    const v = await this.processConfig.obtener(
      distributorId,
      ConfigurableProcess.ROUTE_PLANNING,
    );
    if (v.enabled !== 1) throw planificacionApagada();
    const plan = await this.plans.abrir(distributorId, planDate);
    if (plan.status === RoutePlanStatus.CLOSED) throw planCerrado();
    const r = await this.redis.withLock(
      `route-plan:${distributorId}:${planDate}`,
      CERROJO_TTL_MS,
      () => this.armar(distributorId, planDate, dryRun),
    );
    if (!r.obtenido) throw planOcupado();
    return r.valor;
  }

  private async armar(
    distributorId: string,
    planDate: string,
    dryRun: boolean,
  ): Promise<ResultadoDePropuesta> {
    const params = await this.writer.parametros(distributorId);
    const hojas = await this.dataSource.getRepository(RouteBatch).find({
      where: { distributorId, planDate, kind: RouteBatchKind.PLANNED },
    });
    const vivas = hojas.filter(
      (h) =>
        h.status === RouteBatchStatus.DRAFT ||
        h.status === RouteBatchStatus.CONFIRMED ||
        h.status === RouteBatchStatus.ASSIGNED,
    );
    const rehacer = vivas.filter(
      (h) =>
        h.status === RouteBatchStatus.DRAFT &&
        h.proposedBy === RouteProposedBy.SYSTEM &&
        h.editedAt === null,
    );
    const conservadas = vivas.filter((h) => !rehacer.includes(h));
    const ocupados = {
      choferes: new Set(conservadas.map((h) => h.deliveryId).filter(Boolean)),
      vehiculos: new Set(conservadas.map((h) => h.carId).filter(Boolean)),
    };

    const todos = await this.data.pedidosSinHoja(
      distributorId,
      planDate,
      rehacer.map((h) => h.batchId),
    );
    const unassigned: ResultadoDePropuesta['unassigned'] = [];
    const elegibles = todos.filter((p) => {
      const motivo = motivoNoPlanificable(p, planDate);
      if (motivo) {
        unassigned.push({
          orderId: p.orderId,
          reason: p.hasPoint ? 'not_plannable' : 'no_point',
        });
        return false;
      }
      if (p.offeredNow) {
        unassigned.push({ orderId: p.orderId, reason: 'dispatch_offer' });
        return false;
      }
      return true;
    });

    const pares = emparejar(
      (await this.data.choferes(distributorId, undefined, planDate)).filter(
        (c) => c.available && !ocupados.choferes.has(c.deliveryId),
      ),
      (await this.data.vehiculos(distributorId, undefined, planDate)).filter(
        (c) => c.available && !ocupados.vehiculos.has(c.carId),
      ),
    );
    const deposito = await this.data.deposito(distributorId, null);
    const startMs = salidaPorOmision(
      planDate,
      elegibles.map((p) => p.slotStartMs as number),
    );
    const e = await this.calc.escenario(elegibles, deposito, startMs, params);
    const puntoDe = new Map(e.stops.map((s) => [s.id, s.point]));
    const pedidos: FleetOrder[] = elegibles.map((p) => ({
      id: p.orderId,
      point: puntoDe.get(p.orderId) ?? null,
      lat: p.lat,
      lng: p.lng,
      windowStartMs: p.slotStartMs as number,
      windowEndMs: p.slotEndMs as number,
      createdAtMs: p.createdAtMs,
      load: e.loads.get(p.orderId) as FleetOrder['load'],
    }));
    const vehiculos: FleetVehicle[] = pares.map((p) => ({
      id: p.carId,
      capacityKg: p.capacityKg,
      capacityUnits: p.capacityUnits,
    }));
    const flota = planFleet(pedidos, vehiculos, {
      schedule: e.schedule,
      depot: { lat: e.origin.lat, lng: e.origin.lng },
      maxStopsPerSheet: params.maxStopsPerSheet,
    });
    unassigned.push(
      ...flota.unassigned.map((u) => ({
        orderId: u.orderId,
        reason: u.reason,
      })),
    );
    const choferDe = new Map(pares.map((p) => [p.carId, p.deliveryId]));
    const propuestas: HojaPropuesta[] = flota.sheets
      .filter((s) => s.orderIds.length > 0)
      .map((s) => ({
        sheetId: null,
        deliveryId: choferDe.get(s.vehicleId) as string,
        carId: s.vehicleId,
        orderIds: s.orderIds,
        distanceKm: Math.round(s.schedule.totalKm * 100) / 100,
        durationMin: Math.round((s.schedule.finishMs - startMs) / 60_000),
        units: s.totalUnits,
        peakUnits: s.peakUnits,
        weightKg: s.totalKg,
      }));
    const resultado: ResultadoDePropuesta = {
      dryRun,
      candidates: elegibles.length,
      matrixSource: e.source,
      sheets: propuestas,
      unassigned,
      keptSheetIds: conservadas.map((h) => h.batchId),
    };
    if (dryRun) return resultado;

    await this.plans.enElDia(distributorId, planDate, async (manager) => {
      const ahora = new Date();
      for (const vieja of rehacer) {
        const fila = await manager.findOne(RouteBatch, {
          where: { batchId: vieja.batchId, editedAt: IsNull() },
          lock: { mode: 'pessimistic_write' },
        });
        if (!fila || fila.status !== RouteBatchStatus.DRAFT) continue;
        assertTransition(fila.kind, fila.status, RouteBatchStatus.DISSOLVED);
        await this.writer.apagarTodas(manager, fila.batchId, null);
        fila.status = RouteBatchStatus.DISSOLVED;
        fila.closeReason = RouteBatchCloseReason.ADMIN;
        fila.closedAt = ahora;
        await manager.save(fila);
      }
      // Revalidación con los pedidos bloqueados: entre la foto y acá el admin
      // pudo poner alguno en otra hoja (o cancelarlo, o el despacho ofrecerlo).
      // Ésos quedan sin hoja con su motivo; el resto se arma igual.
      const frescos = new Map(
        (
          await this.data.pedidos(
            distributorId,
            propuestas.flatMap((p) => p.orderIds).sort(),
            manager,
            true,
          )
        ).map((p) => [p.orderId, p]),
      );
      for (const p of propuestas) {
        p.orderIds = p.orderIds.filter((orderId) => {
          const f = frescos.get(orderId);
          const reason: MotivoSinHoja | null = !f
            ? 'not_plannable'
            : f.activeBatchId
              ? 'in_route'
              : motivoNoPlanificable(f, planDate)
                ? 'not_plannable'
                : f.offeredNow
                  ? 'dispatch_offer'
                  : null;
          if (reason) unassigned.push({ orderId, reason });
          return reason === null;
        });
      }
      for (const p of propuestas.filter((x) => x.orderIds.length > 0)) {
        const hoja = await manager.save(
          manager.create(RouteBatch, {
            distributorId,
            kind: RouteBatchKind.PLANNED,
            status: RouteBatchStatus.DRAFT,
            planDate,
            deliveryId: p.deliveryId,
            carId: p.carId,
            originWarehouseId: deposito?.warehouseId ?? null,
            plannedStartAt: new Date(startMs),
            totalWeightKg: 0,
            closedAt: null,
            closeReason: null,
            proposedBy: RouteProposedBy.SYSTEM,
            optimizationMethod: RouteOptimizationMethod.NN_2OPT,
            editedAt: null,
          }),
        );
        for (const orderId of p.orderIds) {
          await this.writer.activarParada(
            manager,
            hoja.batchId,
            orderId,
            false,
          );
        }
        await this.writer.escribirOrden(manager, hoja.batchId, p.orderIds);
        await this.writer.recalcular(manager, hoja, params);
        p.sheetId = hoja.batchId;
        p.distanceKm = hoja.totalDistanceKm ?? p.distanceKm;
        p.durationMin = hoja.totalDurationMin ?? p.durationMin;
        p.units = hoja.totalUnits ?? p.units;
        p.peakUnits = hoja.peakUnits ?? p.peakUnits;
        p.weightKg = hoja.totalWeightKg ?? p.weightKg;
      }
      resultado.sheets = propuestas.filter((x) => x.orderIds.length > 0);
      await manager.update(
        RoutePlan,
        { distributorId, planDate },
        {
          status: RoutePlanStatus.PROPOSED,
          proposedAt: ahora,
          proposalSummary: {
            candidates: resultado.candidates,
            sheets: resultado.sheets.length,
            unassigned: unassigned.length,
            method: 'sweep_nn_2opt',
            matrixSource: e.source,
          },
        },
      );
    });
    return resultado;
  }
}

interface Par {
  deliveryId: string;
  carId: string;
  capacityKg: number | null;
  capacityUnits: number | null;
}

/**
 * Pares chofer–vehículo (§6.4 paso 2): primero cada chofer con su vehículo
 * habitual (el que tiene en uso o el que figura a su nombre) si está libre;
 * después los choferes que quedaron con los vehículos que sobran, en orden.
 */
export function emparejar(
  choferes: readonly ChoferDelDia[],
  vehiculos: readonly VehiculoDelDia[],
): Par[] {
  const libres = new Map(vehiculos.map((v) => [v.carId, v]));
  const pares: Par[] = [];
  const sinPar: ChoferDelDia[] = [];
  for (const c of choferes) {
    const v = c.usualCarId ? libres.get(c.usualCarId) : undefined;
    if (v) {
      libres.delete(v.carId);
      pares.push(par(c, v));
    } else {
      sinPar.push(c);
    }
  }
  const resto = [...libres.values()];
  sinPar.forEach((c, i) => {
    if (resto[i]) pares.push(par(c, resto[i]));
  });
  return pares;
}

const par = (c: ChoferDelDia, v: VehiculoDelDia): Par => ({
  deliveryId: c.deliveryId,
  carId: v.carId,
  capacityKg: v.capacityKg,
  capacityUnits: v.capacityUnits,
});
