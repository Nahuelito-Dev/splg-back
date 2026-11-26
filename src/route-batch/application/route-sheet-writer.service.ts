import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { ConfigurableProcess } from '../../distributor/entities/module-config.entity';
import { ProcessConfigService } from '../../distributor/process-config.service';
import {
  RouteBatch,
  RouteMatrixSource,
} from '../../order/entities/route-batch.entity';
import {
  RouteBatchStop,
  RouteStopRemovedReason,
} from '../../order/entities/route-batch-stop.entity';
import { codigoSqlDelError } from '../../common/errors/db-exceptions';
import { computeSchedule } from '../domain/eta';
import { buildLoadProfile } from '../domain/load-profile';
import { salidaPorOmision } from '../domain/route-sheet-rules';
import { minutosDeServicio } from '../domain/tiempo-de-atencion';
import { ServiceTimeService, modoDeServicio } from './service-time.service';
import {
  Escenario,
  ParametrosDeRuteo,
  RouteSheetCalculator,
} from './route-sheet-calculator.service';
import {
  PedidoDeHoja,
  RouteSheetDataService,
} from './route-sheet-data.service';
import { pedidoYaAgrupado } from './route-sheet.exceptions';

/** Un pedido está activo en una sola hoja o lote a la vez. */
const UNICO_PEDIDO_ACTIVO = 'UQ_route_batch_stop_pedido_activo';

/** Desplazamiento de las secuencias mientras se renumera (el CHECK pide ≥ 1 y el único es por parada activa). */
const DESPLAZAMIENTO = 100_000;

export interface EstadoDeHoja {
  pedidos: PedidoDeHoja[];
  escenario: Escenario;
  /** Ids de las paradas activas, en su orden. */
  orden: string[];
  startMs: number;
}

/**
 * Escritura compartida por la propuesta y la edición: paradas, orden y el
 * recálculo de horas, tramos y totales de una hoja. Todo dentro de la
 * transacción (y el cerrojo) de quien llama.
 */
@Injectable()
export class RouteSheetWriter {
  constructor(
    private readonly data: RouteSheetDataService,
    private readonly calc: RouteSheetCalculator,
    private readonly processConfig: ProcessConfigService,
    private readonly serviceTime: ServiceTimeService,
  ) {}

  /**
   * Los parámetros del cálculo. Con `serviceMinutesMode = learned` y muestra
   * suficiente, los minutos por parada son la mediana aprendida; si no, el fijo.
   */
  async parametros(distributorId: string): Promise<ParametrosDeRuteo> {
    const v = await this.processConfig.obtener(
      distributorId,
      ConfigurableProcess.ROUTE_PLANNING,
    );
    const modo = modoDeServicio(v.serviceMinutesMode);
    const aprendido =
      modo === 'learned'
        ? await this.serviceTime.medianaAprendida(distributorId)
        : null;
    return {
      serviceMinutes: minutosDeServicio(v.serviceMinutes, modo, aprendido),
      trafficFactor: v.trafficFactor,
      maxStopsPerSheet: v.maxStopsPerSheet,
    };
  }

  /**
   * `lateOrderPolicy` (§7.3): 1 sugiere en qué borrador insertar el pedido que
   * entró después del cierre; 0 lo deja para el despacho del día, sin sugerencia.
   */
  async sugiereTardios(distributorId: string): Promise<boolean> {
    const v = await this.processConfig.obtener(
      distributorId,
      ConfigurableProcess.ROUTE_PLANNING,
    );
    return v.lateOrderPolicy === 1;
  }

  /**
   * Paradas activas de la hoja, en orden, con la fila bloqueada (dentro de la
   * transacción de una edición). Sin `bloquear`, sólo lectura: la usan las
   * consultas, que no abren transacción.
   */
  paradasActivas(
    manager: EntityManager,
    batchId: string,
    bloquear = true,
  ): Promise<RouteBatchStop[]> {
    return manager.find(RouteBatchStop, {
      where: { batchId, active: true },
      order: { sequence: 'ASC' },
      ...(bloquear ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
  }

  /** Lo que la hoja tiene hoy: pedidos, matriz y orden. */
  async estado(
    manager: EntityManager,
    sheet: RouteBatch,
    params: ParametrosDeRuteo,
    ordenPedido?: readonly string[],
    bloquear = true,
  ): Promise<EstadoDeHoja> {
    const paradas = await this.paradasActivas(manager, sheet.batchId, bloquear);
    const orden = ordenPedido
      ? [...ordenPedido]
      : paradas.map((s) => s.orderId);
    const pedidos = await this.data.pedidos(
      sheet.distributorId,
      orden,
      manager,
    );
    const porId = new Map(pedidos.map((p) => [p.orderId, p]));
    const enOrden = orden
      .map((id) => porId.get(id))
      .filter((p): p is PedidoDeHoja => !!p);
    const deposito = await this.data.deposito(
      sheet.distributorId,
      sheet.originWarehouseId,
    );
    const startMs =
      sheet.plannedStartAt?.getTime() ??
      salidaPorOmision(
        sheet.planDate as string,
        enOrden
          .map((p) => p.slotStartMs)
          .filter((x): x is number => x !== null),
      );
    const fijadas = new Set(
      paradas.filter((s) => s.sequenceLocked).map((s) => s.orderId),
    );
    const escenario = await this.calc.escenario(
      enOrden,
      deposito,
      startMs,
      params,
      fijadas,
    );
    return { pedidos: enOrden, escenario, orden, startMs };
  }

  /**
   * Deja las paradas activas en ese orden (1..n). Primero las corre lejos y
   * después pone las finales: el único de secuencia es por parada activa y no
   * se puede diferir.
   */
  async escribirOrden(
    manager: EntityManager,
    batchId: string,
    orden: readonly string[],
  ): Promise<void> {
    if (orden.length === 0) return;
    await manager.query(
      `UPDATE "route_batch_stop" SET "sequence" = "sequence" + $2::int
        WHERE "batch_id" = $1 AND "active"`,
      [batchId, DESPLAZAMIENTO],
    );
    await manager.query(
      `UPDATE "route_batch_stop" s SET "sequence" = v.seq
         FROM unnest($2::uuid[]) WITH ORDINALITY AS v(order_id, seq)
        WHERE s."batch_id" = $1 AND s."active" AND s."order_id" = v.order_id`,
      [batchId, orden],
    );
  }

  /**
   * Activa el pedido en la hoja al final (el orden se escribe después). Si ya
   * estuvo en esta hoja y salió, se reactiva su fila (un pedido una vez por lote).
   */
  async activarParada(
    manager: EntityManager,
    batchId: string,
    orderId: string,
    locked: boolean,
  ): Promise<void> {
    const [{ ultima }]: Array<{ ultima: number }> = await manager.query(
      `SELECT COALESCE(MAX("sequence"), 0)::int AS "ultima" FROM "route_batch_stop"
        WHERE "batch_id" = $1 AND "active"`,
      [batchId],
    );
    const temporal = Math.max(ultima + 1, DESPLAZAMIENTO * 2 + 1);
    const previa = await manager.findOne(RouteBatchStop, {
      where: { batchId, orderId },
    });
    try {
      if (previa) {
        await manager.update(
          RouteBatchStop,
          { stopId: previa.stopId },
          {
            active: true,
            removedAt: null,
            removedReason: null,
            sequenceLocked: locked,
            sequence: temporal,
            plannedEtaAt: null,
          },
        );
        return;
      }
      await manager.insert(RouteBatchStop, {
        batchId,
        orderId,
        sequence: temporal,
        active: true,
        sequenceLocked: locked,
        legDistanceKm: 0,
      });
    } catch (error) {
      // Otra operación (la propuesta, otra hoja, un lote de M4) activó el
      // pedido en el medio: 409 propio, no un 500.
      if (
        codigoSqlDelError(error) === '23505' &&
        restriccionDelError(error) === UNICO_PEDIDO_ACTIVO
      ) {
        throw pedidoYaAgrupado();
      }
      throw error;
    }
  }

  /** Saca la parada de la hoja con su motivo (borrado lógico). */
  async apagarParada(
    manager: EntityManager,
    batchId: string,
    orderId: string,
    motivo: RouteStopRemovedReason,
  ): Promise<void> {
    await manager.update(
      RouteBatchStop,
      { batchId, orderId, active: true },
      { active: false, removedReason: motivo, removedAt: new Date() },
    );
  }

  async apagarTodas(
    manager: EntityManager,
    batchId: string,
    motivo: RouteStopRemovedReason | null,
  ): Promise<void> {
    await manager.update(
      RouteBatchStop,
      { batchId, active: true },
      motivo
        ? { active: false, removedReason: motivo, removedAt: new Date() }
        : { active: false },
    );
  }

  /**
   * Recalcula horas, tramos y totales con el orden vigente y los guarda en la
   * hoja y en cada parada. Devuelve el estado para quien lo necesite.
   */
  async recalcular(
    manager: EntityManager,
    sheet: RouteBatch,
    params: ParametrosDeRuteo,
  ): Promise<EstadoDeHoja> {
    const e = await this.estado(manager, sheet, params);
    const sch = computeSchedule(e.escenario.stops, e.escenario.schedule);
    const perfil = buildLoadProfile(
      e.escenario.stops.map((s) => s.id),
      e.escenario.loads,
    );
    for (const s of sch.stops) {
      await manager.update(
        RouteBatchStop,
        { batchId: sheet.batchId, orderId: s.id, active: true },
        {
          etaAt: new Date(s.etaMs),
          legDistanceKm: Math.round(s.legKm * 100) / 100,
          legDurationMin: Math.round(s.legMin * 10) / 10,
        },
      );
    }
    const vacia = sch.stops.length === 0;
    sheet.totalDistanceKm = vacia ? 0 : Math.round(sch.totalKm * 100) / 100;
    sheet.totalDurationMin = vacia
      ? 0
      : Math.round((sch.finishMs - e.startMs) / 60_000);
    sheet.totalUnits = perfil.totalUnits;
    sheet.peakUnits = perfil.peakUnits;
    sheet.totalWeightKg = perfil.totalKg;
    sheet.matrixSource = e.escenario.source as RouteMatrixSource;
    await manager.save(sheet);
    return e;
  }
}

function restriccionDelError(error: unknown): unknown {
  const e = error as {
    constraint?: unknown;
    driverError?: { constraint?: unknown };
  };
  return e.constraint ?? e.driverError?.constraint;
}
