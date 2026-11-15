import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { ConfigurableProcess } from '../../distributor/entities/module-config.entity';
import { ProcessConfigService } from '../../distributor/process-config.service';
import { RouteBatch } from '../../order/entities/route-batch.entity';
import {
  RouteBatchStop,
  RouteStopRemovedReason,
} from '../../order/entities/route-batch-stop.entity';
import { RedisService } from '../../redis/redis.service';
import { estimatedWindow } from '../domain/eta';
import { RouteBatchKind, RouteBatchStatus } from '../domain/route-batch.enums';
import {
  partirRecorrido,
  progresoDeParada,
  siguienteParada,
} from '../domain/route-sheet-execution';
import { RouteSheetDataService } from './route-sheet-data.service';
import { hojaNoEncontrada, pedidoNoEncontrado } from './route-sheet.exceptions';
import type {
  OrderEtaDto,
  RouteSheetExecutionDto,
  RouteSheetExecutionStopDto,
} from '../presentation/dto/route-sheet-execution.dto';

const iso = (d: Date | null | undefined): string | null =>
  d ? d.toISOString() : null;
const isoMs = (ms: number | null | undefined): string | null =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString();

/** Motivos de salida en la calle con los que el pedido espera al admin. */
const ESPERAN_AL_ADMIN: readonly string[] = [
  'rescheduled',
  'needs_reschedule',
  'admin',
  'sheet_closed',
];

/** Estados en los que el chofer ve su hoja (no ve borradores ni canceladas). */
const VISIBLES_AL_CHOFER = [
  RouteBatchStatus.CONFIRMED,
  RouteBatchStatus.ASSIGNED,
  RouteBatchStatus.COMPLETED,
];

/**
 * Lecturas de la hoja en curso (§9.2, §9.3): la hoja del chofer (la de hoy o
 * la próxima confirmada), el seguimiento del panel y la hora estimada que ve el
 * cliente. Sólo leen (sirven en modo soporte): no recalculan ni escriben.
 */
@Injectable()
export class RouteSheetExecutionQueryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly data: RouteSheetDataService,
    private readonly processConfig: ProcessConfigService,
    private readonly redis: RedisService,
  ) {}

  /** La hoja de hoy del chofer (confirmada o en curso), o la próxima confirmada; `null` si no tiene. */
  async actualDelChofer(
    distributorId: string,
    userId: string,
  ): Promise<RouteSheetExecutionDto | null> {
    const [fila]: Array<{ batchId: string }> = await this.dataSource.query(
      `SELECT b."batch_id" AS "batchId" FROM "route_batch" b
         JOIN "delivery" d ON d."delivery_id" = b."delivery_id"
        WHERE d."user_id" = $1 AND b."distributor_id" = $2 AND b."kind" = 'planned'
          AND ((b."status" = 'assigned')
               OR (b."status" = 'confirmed' AND b."plan_date" >= $3::date))
        ORDER BY (b."status" = 'assigned') DESC, b."plan_date" ASC, b."batch_id"
        LIMIT 1`,
      [userId, distributorId, diaArgentino()],
    );
    return fila ? this.armar(distributorId, fila.batchId, false) : null;
  }

  /** Una hoja del chofer (confirmada, en curso o cerrada); la de otro chofer es 404. */
  async delChofer(
    distributorId: string,
    userId: string,
    id: string,
  ): Promise<RouteSheetExecutionDto> {
    const filas: unknown[] = await this.dataSource.query(
      `SELECT 1 FROM "route_batch" b JOIN "delivery" d ON d."delivery_id" = b."delivery_id"
        WHERE b."batch_id" = $1 AND b."distributor_id" = $2 AND d."user_id" = $3
          AND b."kind" = 'planned' AND b."status"::text = ANY($4::text[])`,
      [id, distributorId, userId, VISIBLES_AL_CHOFER],
    );
    if (filas.length === 0) throw hojaNoEncontrada();
    return this.armar(distributorId, id, false);
  }

  /** Seguimiento del panel: cualquier hoja de la distribuidora, con la última posición del chofer. */
  seguimiento(
    distributorId: string,
    id: string,
  ): Promise<RouteSheetExecutionDto> {
    return this.armar(distributorId, id, true);
  }

  /**
   * La franja estimada de un pedido del cliente que está en una hoja confirmada
   * o en curso; `null` si no está en ninguna (o ya se entregó o canceló). No
   * expone la hoja, el orden ni otros clientes.
   */
  async etaDelPedido(
    customerUserId: string,
    orderId: string,
  ): Promise<OrderEtaDto | null> {
    const suyo: unknown[] = await this.dataSource.query(
      `SELECT 1 FROM "order" WHERE "order_id" = $1 AND "customer_id" = $2`,
      [orderId, customerUserId],
    );
    // El pedido de otro cliente no se distingue de uno que no existe.
    if (suyo.length === 0) throw pedidoNoEncontrado();
    const [f]: Array<{
      distributorId: string;
      status: RouteBatchStatus;
      etaAt: Date | null;
      ws: Date | null;
      we: Date | null;
      notifiedAt: Date | null;
      startedAt: Date | null;
    }> = await this.dataSource.query(
      `SELECT b."distributor_id" AS "distributorId", b."status"::text AS "status",
              s."eta_at" AS "etaAt", s."notified_window_start" AS "ws", s."notified_window_end" AS "we",
              s."notified_at" AS "notifiedAt", b."started_at" AS "startedAt"
         FROM "order" o
         JOIN "route_batch_stop" s ON s."order_id" = o."order_id" AND s."active"
         JOIN "route_batch" b ON b."batch_id" = s."batch_id"
        WHERE o."order_id" = $1 AND o."customer_id" = $2
          AND o."status"::text NOT IN ('delivered', 'cancelled')
          AND b."kind" = 'planned' AND b."status" IN ('confirmed', 'assigned')
        LIMIT 1`,
      [orderId, customerUserId],
    );
    if (!f?.etaAt) return null;
    let ws = f.ws;
    let we = f.we;
    if (!ws || !we) {
      const [p] = await this.data.pedidos(f.distributorId, [orderId]);
      const params = await this.processConfig.obtener(
        f.distributorId,
        ConfigurableProcess.ROUTE_PLANNING,
      );
      if (p?.slotStartMs == null || p.slotEndMs == null) return null;
      const v = estimatedWindow(
        f.etaAt.getTime(),
        p.slotStartMs,
        p.slotEndMs,
        params.etaWindowMinutes,
      );
      ws = new Date(v.startMs);
      we = new Date(v.endMs);
    }
    return {
      orderId,
      etaAt: f.etaAt.toISOString(),
      windowStart: ws.toISOString(),
      windowEnd: we.toISOString(),
      source: 'route_sheet',
      inProgress: f.status === RouteBatchStatus.ASSIGNED,
      updatedAt: (f.notifiedAt ?? f.startedAt ?? f.etaAt).toISOString(),
    };
  }

  private async armar(
    distributorId: string,
    id: string,
    conPosicion: boolean,
  ): Promise<RouteSheetExecutionDto> {
    const sheet = await this.dataSource.manager.findOne(RouteBatch, {
      where: { batchId: id, distributorId, kind: RouteBatchKind.PLANNED },
    });
    if (!sheet) throw hojaNoEncontrada();
    const todas = await this.dataSource.manager.find(RouteBatchStop, {
      where: { batchId: id },
    });
    // Antes de iniciar sólo cuentan las activas; después, también las que
    // salieron en la calle (no las que se movieron mientras se planificaba).
    const inicio = sheet.startedAt ?? null;
    const visibles = todas.filter(
      (s) =>
        s.active ||
        (inicio !== null &&
          (s.removedReason === null ||
            (!!s.removedAt && s.removedAt >= inicio))),
    );
    visibles.sort(
      (a, b) => Number(b.active) - Number(a.active) || a.sequence - b.sequence,
    );
    const pedidos = new Map(
      (
        await this.data.pedidos(
          distributorId,
          visibles.map((s) => s.orderId),
        )
      ).map((p) => [p.orderId, p]),
    );
    const espera = (
      await this.processConfig.obtener(
        distributorId,
        ConfigurableProcess.ROUTE_PLANNING,
      )
    ).arrivalWaitMinutes;
    const renglones = await this.renglones(visibles.map((s) => s.orderId));
    const stops: RouteSheetExecutionStopDto[] = visibles.map((s) => {
      const p = pedidos.get(s.orderId);
      const progress = progresoDeParada(s, p?.status ?? null);
      return {
        orderId: s.orderId,
        sequence: s.active ? s.sequence : null,
        progress,
        removedReason: s.removedReason,
        removedNote: s.removedNote,
        removedAt: iso(s.removedAt),
        arrivedAt: iso(s.arrivedAt),
        waitExpiresAt:
          s.active && s.arrivedAt
            ? new Date(s.arrivedAt.getTime() + espera * 60_000).toISOString()
            : null,
        failedAttempts: s.failedAttempts ?? 0,
        lastFailedAt: iso(s.lastFailedAt),
        lastFailureNote: s.lastFailureNote ?? null,
        awaitingAdmin:
          !s.active &&
          inicio !== null &&
          !!s.removedAt &&
          s.removedAt >= inicio &&
          ESPERAN_AL_ADMIN.includes(s.removedReason as string) &&
          p?.status === 'pending' &&
          p.deliveryId === null &&
          (s.removedReason === RouteStopRemovedReason.NEEDS_RESCHEDULE ||
            p.scheduledDate === sheet.planDate),
        rescheduledTo:
          !s.active &&
          !!p?.scheduledDate &&
          p.scheduledDate !== sheet.planDate &&
          p.status !== 'delivered' &&
          p.status !== 'cancelled'
            ? p.scheduledDate
            : null,
        customerName: p?.customerName ?? null,
        customerPhone: p?.customerPhone ?? null,
        address: p?.address ?? null,
        lat: p?.lat ?? null,
        lng: p?.lng ?? null,
        slotName: p?.slotName ?? null,
        slotStart: isoMs(p?.slotStartMs),
        slotEnd: isoMs(p?.slotEndMs),
        etaAt: iso(s.etaAt),
        plannedEtaAt: iso(s.plannedEtaAt),
        notifiedWindowStart: iso(s.notifiedWindowStart),
        notifiedWindowEnd: iso(s.notifiedWindowEnd),
        late:
          (progress === 'pending' || progress === 'on_the_way') &&
          !!s.etaAt &&
          p?.slotEndMs != null &&
          s.etaAt.getTime() > p.slotEndMs,
        units: p?.units ?? 0,
        emptiesExpected: p?.collectUnits ?? 0,
        weightKg: p?.weightKg ?? 0,
        unpaidOnline: p?.unpaidOnline ?? false,
        items: renglones.get(s.orderId) ?? [],
      };
    });
    const activas = stops.filter((s) => s.sequence !== null);
    const r = partirRecorrido(activas);
    const [extra]: Array<{
      driverName: string | null;
      driverUserId: string | null;
      carPatent: string | null;
    }> = await this.dataSource.query(
      `SELECT u."full_name" AS "driverName", u."user_id" AS "driverUserId", c."car_patent" AS "carPatent"
         FROM "route_batch" b
         LEFT JOIN "delivery" d ON d."delivery_id" = b."delivery_id"
         LEFT JOIN "user" u ON u."user_id" = d."user_id"
         LEFT JOIN "car" c ON c."car_id" = b."car_id"
        WHERE b."batch_id" = $1`,
      [id],
    );
    return {
      id: sheet.batchId,
      number: sheet.number,
      planDate: sheet.planDate as string,
      status: sheet.status,
      version: sheet.version,
      deliveryId: sheet.deliveryId,
      driverName: extra?.driverName ?? null,
      carId: sheet.carId,
      carPatent: extra?.carPatent ?? null,
      truckLoadId: sheet.truckLoadId,
      plannedStartAt: iso(sheet.plannedStartAt),
      assignedAt: iso(sheet.assignedAt),
      startedAt: iso(sheet.startedAt),
      closedAt: iso(sheet.closedAt),
      closeNote: sheet.closeNote,
      currentOrderId: r.enCamino,
      nextOrderId:
        sheet.status === RouteBatchStatus.ASSIGNED ? siguienteParada(r) : null,
      progress: {
        total: stops.length,
        delivered: stops.filter((s) => s.progress === 'delivered').length,
        failed: stops.filter((s) => s.progress === 'failed').length,
        removed: stops.filter((s) => s.progress === 'removed').length,
        pending: stops.filter(
          (s) => s.progress === 'pending' || s.progress === 'on_the_way',
        ).length,
      },
      driverLocation:
        conPosicion && extra?.driverUserId
          ? await this.posicion(extra.driverUserId)
          : null,
      stops,
    };
  }

  private async renglones(
    orderIds: string[],
  ): Promise<
    Map<
      string,
      Array<{ gasCylinderId: string; type: string | null; quantity: number }>
    >
  > {
    const m = new Map<
      string,
      Array<{ gasCylinderId: string; type: string | null; quantity: number }>
    >();
    if (orderIds.length === 0) return m;
    const filas: Array<{
      orderId: string;
      gasCylinderId: string;
      type: string | null;
      quantity: number;
    }> = await this.dataSource.query(
      `SELECT oi."order_id" AS "orderId", oi."gas_cylinder_id" AS "gasCylinderId", gc."type" AS "type",
              oi."quantity"::int AS "quantity"
         FROM "order_item" oi JOIN "gas_cylinder" gc ON gc."gas_cylinder_id" = oi."gas_cylinder_id"
        WHERE oi."order_id" = ANY($1::uuid[])
        ORDER BY gc."type", oi."gas_cylinder_id"`,
      [orderIds],
    );
    for (const f of filas) {
      m.set(f.orderId, [
        ...(m.get(f.orderId) ?? []),
        { gasCylinderId: f.gasCylinderId, type: f.type, quantity: f.quantity },
      ]);
    }
    return m;
  }

  private async posicion(
    userId: string,
  ): Promise<{ lat: number; lng: number; at: string | null } | null> {
    try {
      return await this.redis.getDriverLastLocation(userId);
    } catch {
      return null;
    }
  }
}
