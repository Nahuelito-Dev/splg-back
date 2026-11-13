import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  RouteBatch,
  RouteOptimizationMethod,
  RouteProposedBy,
} from '../../order/entities/route-batch.entity';
import { RouteStopRemovedReason } from '../../order/entities/route-batch-stop.entity';
import { RouteStop, computeSchedule } from '../domain/eta';
import { InsertionFailure, bestInsertion } from '../domain/insertion';
import { optimizeStops } from '../domain/stop-optimizer';
import { RouteBatchKind, RouteBatchStatus } from '../domain/route-batch.enums';
import {
  esEditable,
  esPermutacionDe,
  motivoNoPlanificable,
} from '../domain/route-sheet-rules';
import { ParametrosDeRuteo } from './route-sheet-calculator.service';
import { RouteSheetDataService } from './route-sheet-data.service';
import { RouteSheetLocks } from './route-sheet-locks.service';
import { RouteSheetWriter } from './route-sheet-writer.service';
import { RoutePlanService } from './route-plan.service';
import {
  choferConOtraHoja,
  choferNoEncontrado,
  depositoNoEncontrado,
  fijadasFueraDeLaHoja,
  hojaNoEditable,
  hojaOtroDia,
  mismaHoja,
  paradaNoEncontrada,
  paradaNoFactible,
  pedidoNoEncontrado,
  pedidoNoPlanificable,
  pedidoYaAgrupado,
  secuenciaInvalida,
  vehiculoConOtraHoja,
  vehiculoNoEncontrado,
} from './route-sheet.exceptions';

export interface CambiosDeHoja {
  version: number;
  deliveryId?: string;
  carId?: string;
  plannedStartAt?: string;
  originWarehouseId?: string;
}

export interface ResultadoDeOptimizacion {
  before: ResumenDeOrden;
  after: ResumenDeOrden;
}

export interface ResumenDeOrden {
  durationMin: number;
  distanceKm: number;
  lateStops: number;
}

const MOTIVO_INSERCION: Record<InsertionFailure, string> = {
  window: 'no llega dentro de su franja en ninguna posición',
  capacity: 'supera la capacidad del vehículo',
  max_stops: 'la hoja llegó al máximo de paradas',
};

/**
 * Alta manual y edición de las hojas en borrador (§9.1): datos de la hoja,
 * agregar, quitar, mover entre hojas, ordenar a mano y re-optimizar. Cada
 * operación corre con el cerrojo de la hoja, la fila bloqueada y la versión
 * que vio quien edita; al terminar se recalculan horas y totales.
 */
@Injectable()
export class RouteSheetEditingService {
  constructor(
    private readonly locks: RouteSheetLocks,
    private readonly writer: RouteSheetWriter,
    private readonly data: RouteSheetDataService,
    private readonly plans: RoutePlanService,
  ) {}

  /** Alta manual: abre el día si hacía falta. Devuelve el id de la hoja. */
  async crear(
    distributorId: string,
    body: {
      planDate: string;
      deliveryId?: string;
      carId?: string;
      orderIds?: string[];
    },
  ): Promise<string> {
    await this.plans.abrirParaEditar(distributorId, body.planDate);
    if (body.deliveryId)
      await this.assertChofer(distributorId, body.deliveryId);
    if (body.carId) await this.assertVehiculo(distributorId, body.carId);
    const params = await this.writer.parametros(distributorId);
    const ids = body.orderIds ?? [];
    if (ids.length > params.maxStopsPerSheet) {
      throw paradaNoFactible(MOTIVO_INSERCION.max_stops);
    }
    return this.plans.enElDia(distributorId, body.planDate, async (manager) => {
      const sheet = await manager.save(
        manager.create(RouteBatch, {
          distributorId,
          kind: RouteBatchKind.PLANNED,
          status: RouteBatchStatus.DRAFT,
          planDate: body.planDate,
          deliveryId: body.deliveryId ?? null,
          carId: body.carId ?? null,
          totalWeightKg: 0,
          closedAt: null,
          closeReason: null,
          proposedBy: RouteProposedBy.ADMIN,
          optimizationMethod: RouteOptimizationMethod.MANUAL,
          editedAt: new Date(),
        }),
      );
      // Todos los pedidos bloqueados de una vez, en orden de id.
      await this.data.pedidos(distributorId, [...ids].sort(), manager, true);
      for (const orderId of ids) {
        await this.assertPlanificable(manager, sheet, orderId);
        await this.writer.activarParada(manager, sheet.batchId, orderId, false);
      }
      await this.writer.escribirOrden(manager, sheet.batchId, ids);
      await this.writer.recalcular(manager, sheet, params);
      return sheet.batchId;
    });
  }

  async editar(
    distributorId: string,
    id: string,
    cambios: CambiosDeHoja,
  ): Promise<void> {
    if (cambios.deliveryId)
      await this.assertChofer(distributorId, cambios.deliveryId);
    if (cambios.carId) await this.assertVehiculo(distributorId, cambios.carId);
    if (
      cambios.originWarehouseId &&
      !(await this.data.existeDeposito(
        distributorId,
        cambios.originWarehouseId,
      ))
    ) {
      throw depositoNoEncontrado();
    }
    const params = await this.writer.parametros(distributorId);
    await this.locks.conHojas(
      distributorId,
      [{ id, version: cambios.version }],
      async (manager, [sheet]) => {
        this.assertEditable(sheet);
        const ocupados = await this.data.ocupadosDelDia(
          distributorId,
          sheet.planDate as string,
          sheet.batchId,
          manager,
        );
        if (
          cambios.deliveryId &&
          ocupados.deliveryIds.has(cambios.deliveryId)
        ) {
          throw choferConOtraHoja();
        }
        if (cambios.carId && ocupados.carIds.has(cambios.carId)) {
          throw vehiculoConOtraHoja();
        }
        if (cambios.deliveryId !== undefined)
          sheet.deliveryId = cambios.deliveryId;
        if (cambios.carId !== undefined) sheet.carId = cambios.carId;
        if (cambios.originWarehouseId !== undefined) {
          sheet.originWarehouseId = cambios.originWarehouseId;
        }
        if (cambios.plannedStartAt !== undefined) {
          sheet.plannedStartAt = new Date(cambios.plannedStartAt);
        }
        sheet.editedAt = new Date();
        await this.writer.recalcular(manager, sheet, params);
      },
    );
  }

  /** Agrega una parada: en la posición pedida o en la inserción más barata factible (§6.5). */
  async agregar(
    distributorId: string,
    id: string,
    body: {
      version: number;
      orderId: string;
      position?: number;
      lock?: boolean;
      acceptLateStops?: boolean;
    },
  ): Promise<void> {
    const params = await this.writer.parametros(distributorId);
    await this.locks.conHojas(
      distributorId,
      [{ id, version: body.version }],
      async (manager, [sheet]) => {
        this.assertEditable(sheet);
        await this.assertPlanificable(manager, sheet, body.orderId);
        const orden = await this.insertar(
          manager,
          sheet,
          params,
          body.orderId,
          {
            position: body.position,
            allowLate: body.acceptLateStops === true,
          },
        );
        await this.writer.activarParada(
          manager,
          sheet.batchId,
          body.orderId,
          body.lock === true,
        );
        await this.writer.escribirOrden(manager, sheet.batchId, orden);
        sheet.editedAt = new Date();
        await this.writer.recalcular(manager, sheet, params);
      },
    );
  }

  /** Quita la parada (borrado lógico): el pedido vuelve a «sin asignar». */
  async quitar(
    distributorId: string,
    id: string,
    orderId: string,
    version: number,
  ): Promise<void> {
    const params = await this.writer.parametros(distributorId);
    await this.locks.conHojas(
      distributorId,
      [{ id, version }],
      async (manager, [sheet]) => {
        this.assertEditable(sheet);
        const paradas = await this.writer.paradasActivas(
          manager,
          sheet.batchId,
        );
        if (!paradas.some((s) => s.orderId === orderId)) {
          throw paradaNoEncontrada();
        }
        await this.writer.apagarParada(
          manager,
          sheet.batchId,
          orderId,
          RouteStopRemovedReason.ADMIN,
        );
        await this.writer.escribirOrden(
          manager,
          sheet.batchId,
          paradas.filter((s) => s.orderId !== orderId).map((s) => s.orderId),
        );
        sheet.editedAt = new Date();
        await this.writer.recalcular(manager, sheet, params);
      },
    );
  }

  /** Mueve la parada a otra hoja del mismo día (las dos en borrador). */
  async mover(
    distributorId: string,
    sourceId: string,
    orderId: string,
    body: {
      version: number;
      targetSheetId: string;
      targetVersion: number;
      position?: number;
      acceptLateStops?: boolean;
    },
  ): Promise<void> {
    if (sourceId === body.targetSheetId) throw mismaHoja();
    const params = await this.writer.parametros(distributorId);
    await this.locks.conHojas(
      distributorId,
      [
        { id: sourceId, version: body.version },
        { id: body.targetSheetId, version: body.targetVersion },
      ],
      async (manager, [source, target]) => {
        this.assertEditable(source);
        this.assertEditable(target);
        if (source.planDate !== target.planDate) throw hojaOtroDia();
        const paradas = await this.writer.paradasActivas(
          manager,
          source.batchId,
        );
        const parada = paradas.find((s) => s.orderId === orderId);
        if (!parada) throw paradaNoEncontrada();
        await this.writer.apagarParada(
          manager,
          source.batchId,
          orderId,
          RouteStopRemovedReason.MOVED,
        );
        await this.writer.escribirOrden(
          manager,
          source.batchId,
          paradas.filter((s) => s.orderId !== orderId).map((s) => s.orderId),
        );
        const orden = await this.insertar(manager, target, params, orderId, {
          position: body.position,
          allowLate: body.acceptLateStops === true,
        });
        await this.writer.activarParada(
          manager,
          target.batchId,
          orderId,
          parada.sequenceLocked,
        );
        await this.writer.escribirOrden(manager, target.batchId, orden);
        const ahora = new Date();
        source.editedAt = ahora;
        target.editedAt = ahora;
        await this.writer.recalcular(manager, source, params);
        await this.writer.recalcular(manager, target, params);
      },
    );
  }

  /** Orden manual del administrador: exactamente las paradas activas (400 si no). */
  async ordenar(
    distributorId: string,
    id: string,
    body: { version: number; orderIds: string[]; locked?: string[] },
  ): Promise<void> {
    const params = await this.writer.parametros(distributorId);
    await this.locks.conHojas(
      distributorId,
      [{ id, version: body.version }],
      async (manager, [sheet]) => {
        this.assertEditable(sheet);
        const paradas = await this.writer.paradasActivas(
          manager,
          sheet.batchId,
        );
        const activas = paradas.map((s) => s.orderId);
        if (!esPermutacionDe(activas, body.orderIds)) throw secuenciaInvalida();
        if (body.locked && body.locked.some((o) => !activas.includes(o))) {
          throw fijadasFueraDeLaHoja();
        }
        await this.writer.escribirOrden(manager, sheet.batchId, body.orderIds);
        if (body.locked) {
          const fijadas = new Set(body.locked);
          for (const s of paradas) {
            await manager.update(
              'route_batch_stop',
              { stopId: s.stopId },
              { sequenceLocked: fijadas.has(s.orderId) },
            );
          }
        }
        sheet.optimizationMethod = RouteOptimizationMethod.MANUAL;
        sheet.editedAt = new Date();
        await this.writer.recalcular(manager, sheet, params);
      },
    );
  }

  /** Re-optimiza respetando las fijadas; devuelve cómo estaba y cómo quedó. */
  async optimizar(
    distributorId: string,
    id: string,
    version: number,
  ): Promise<ResultadoDeOptimizacion> {
    const params = await this.writer.parametros(distributorId);
    return this.locks.conHojas(
      distributorId,
      [{ id, version }],
      async (manager, [sheet]) => {
        this.assertEditable(sheet);
        const e = await this.writer.estado(manager, sheet, params);
        const antes = resumen(
          computeSchedule(e.escenario.stops, e.escenario.schedule),
          e.startMs,
        );
        const r = optimizeStops(e.escenario.stops, e.escenario.schedule, {
          lateStops: 'keep',
        });
        const orden = [...r.order, ...r.excluded.map((x) => x.id)];
        await this.writer.escribirOrden(manager, sheet.batchId, orden);
        sheet.optimizationMethod = RouteOptimizationMethod.NN_2OPT;
        sheet.editedAt = new Date();
        const despues = await this.writer.recalcular(manager, sheet, params);
        const nuevo = computeSchedule(
          despues.escenario.stops,
          despues.escenario.schedule,
        );
        return { before: antes, after: resumen(nuevo, despues.startMs) };
      },
    );
  }

  // ───────────────────────── reglas ─────────────────────────

  private assertEditable(sheet: RouteBatch): void {
    if (!esEditable(sheet.status)) throw hojaNoEditable();
  }

  /** El pedido es de la distribuidora, de ese día y sin otra hoja o lote vivo. */
  private async assertPlanificable(
    manager: EntityManager,
    sheet: RouteBatch,
    orderId: string,
  ): Promise<void> {
    const [p] = await this.data.pedidos(
      sheet.distributorId,
      [orderId],
      manager,
      true,
    );
    if (!p) throw pedidoNoEncontrado();
    if (p.activeBatchId) throw pedidoYaAgrupado();
    const motivo = motivoNoPlanificable(p, sheet.planDate as string);
    if (motivo) throw pedidoNoPlanificable(motivo);
  }

  /**
   * El orden nuevo de la hoja con el pedido insertado: en la posición del admin
   * o en la más barata. En los dos casos tiene que entrar en la capacidad del
   * vehículo y, salvo `allowLate`, dejar todas las paradas en su franja.
   */
  private async insertar(
    manager: EntityManager,
    sheet: RouteBatch,
    params: ParametrosDeRuteo,
    orderId: string,
    o: { position?: number; allowLate: boolean },
  ): Promise<string[]> {
    const conNuevo = await this.writer.estado(manager, sheet, params, [
      ...(await this.writer.paradasActivas(manager, sheet.batchId)).map(
        (s) => s.orderId,
      ),
      orderId,
    ]);
    const stops = conNuevo.escenario.stops;
    const candidata = stops.find((s) => s.id === orderId) as RouteStop;
    const ruta = stops.filter((s) => s.id !== orderId);
    if (ruta.length >= params.maxStopsPerSheet) {
      throw paradaNoFactible(MOTIVO_INSERCION.max_stops);
    }
    const [vehiculo] = sheet.carId
      ? await this.data.vehiculos(sheet.distributorId, [sheet.carId])
      : [];
    const r = bestInsertion(
      ruta,
      candidata,
      {
        schedule: conNuevo.escenario.schedule,
        maxStops: params.maxStopsPerSheet,
        ...(vehiculo
          ? {
              capacity: {
                capacityKg: vehiculo.capacityKg,
                capacityUnits: vehiculo.capacityUnits,
                loads: conNuevo.escenario.loads,
              },
            }
          : {}),
      },
      {
        allowLate: o.allowLate,
        // La posición del admin (1 = primera) se evalúa sola, con las mismas
        // reglas de franja y capacidad que la inserción más barata.
        ...(o.position !== undefined ? { position: o.position - 1 } : {}),
      },
    );
    if (!r.ok) throw paradaNoFactible(MOTIVO_INSERCION[r.reason]);
    return r.order.map((s) => s.id);
  }

  private async assertChofer(distributorId: string, deliveryId: string) {
    const [c] = await this.data.choferes(distributorId, [deliveryId]);
    if (!c) throw choferNoEncontrado();
  }

  private async assertVehiculo(distributorId: string, carId: string) {
    const [v] = await this.data.vehiculos(distributorId, [carId]);
    if (!v) throw vehiculoNoEncontrado();
  }
}

function resumen(
  s: { finishMs: number; totalKm: number; lateCount: number; stops: unknown[] },
  startMs: number,
): ResumenDeOrden {
  return {
    durationMin:
      s.stops.length === 0 ? 0 : Math.round((s.finishMs - startMs) / 60_000),
    distanceKm: Math.round(s.totalKm * 100) / 100,
    lateStops: s.lateCount,
  };
}
