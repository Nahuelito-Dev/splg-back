import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Not, Repository } from 'typeorm';
import {
  RouteBatch,
  RouteMatrixSource,
} from '../../order/entities/route-batch.entity';
import { RouteBatchStop } from '../../order/entities/route-batch-stop.entity';
import { RoutePlan } from '../../order/entities/route-plan.entity';
import { bestInsertion } from '../domain/insertion';
import { RouteBatchKind, RouteBatchStatus } from '../domain/route-batch.enums';
import { motivoNoPlanificable } from '../domain/route-sheet-rules';
import {
  LateOrderDto,
  LoadSuggestionDto,
  RoutePlanDayDto,
  RoutePlanDto,
  RouteSheetDto,
  RouteSheetPageDto,
  RouteSheetWarningDto,
  UnassignedOrderDto,
} from '../presentation/dto/route-sheet-response.dto';
import { EntityPhotoService } from '../../s3/entity-photo.service';
import { RoutePlanService } from './route-plan.service';
import {
  PedidoDeHoja,
  RouteSheetDataService,
} from './route-sheet-data.service';
import { RouteSheetLocks } from './route-sheet-locks.service';
import { RouteSheetWriter } from './route-sheet-writer.service';
import { ROUTE_PLAN_CODES, hojaNoEncontrada } from './route-sheet.exceptions';

const iso = (d: Date | null | undefined): string | null =>
  d ? d.toISOString() : null;
const isoMs = (ms: number | null): string | null =>
  ms === null ? null : new Date(ms).toISOString();

/** Lecturas de la hoja de ruta para el panel (§9.1). Todo por distribuidora: lo ajeno es 404. */
@Injectable()
export class RouteSheetQueryService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(RouteBatch)
    private readonly sheets: Repository<RouteBatch>,
    @InjectRepository(RouteBatchStop)
    private readonly stops: Repository<RouteBatchStop>,
    private readonly data: RouteSheetDataService,
    private readonly plans: RoutePlanService,
    private readonly writer: RouteSheetWriter,
    private readonly locks: RouteSheetLocks,
    private readonly fotos: EntityPhotoService,
  ) {}

  async detalle(distributorId: string, id: string): Promise<RouteSheetDto> {
    const sheet = await this.sheets.findOne({
      where: { batchId: id, distributorId, kind: RouteBatchKind.PLANNED },
    });
    if (!sheet) throw hojaNoEncontrada();
    const [dto] = await this.mapear(distributorId, [sheet]);
    return dto;
  }

  async listar(
    distributorId: string,
    q: {
      date?: string;
      status?: RouteBatchStatus;
      deliveryId?: string;
      limit: number;
      offset: number;
    },
  ): Promise<RouteSheetPageDto> {
    const [filas, total] = await this.sheets.findAndCount({
      where: {
        distributorId,
        kind: RouteBatchKind.PLANNED,
        ...(q.date ? { planDate: q.date } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.deliveryId ? { deliveryId: q.deliveryId } : {}),
      },
      order: { planDate: 'DESC', createdAt: 'ASC', batchId: 'ASC' },
      take: q.limit,
      skip: q.offset,
    });
    return {
      items: await this.mapear(distributorId, filas),
      total,
      limit: q.limit,
      offset: q.offset,
    };
  }

  /** El día: plan, hojas vivas, «sin asignar» y recursos disponibles. */
  async dia(distributorId: string, planDate: string): Promise<RoutePlanDayDto> {
    const plan = await this.plans.buscar(distributorId, planDate);
    const hojas = await this.sheets.find({
      where: {
        distributorId,
        planDate,
        kind: RouteBatchKind.PLANNED,
        status: Not(RouteBatchStatus.DISSOLVED),
      },
      order: { createdAt: 'ASC', batchId: 'ASC' },
    });
    const sinHoja = await this.data.pedidosSinHoja(distributorId, planDate);
    // Disponibles el día del plan, no hoy (licencias, vencimientos, taller).
    const choferes = await this.data.choferes(
      distributorId,
      undefined,
      planDate,
    );
    const vehiculos = await this.data.vehiculos(
      distributorId,
      undefined,
      planDate,
    );
    const vivas = hojas.filter((h) =>
      [RouteBatchStatus.CONFIRMED, RouteBatchStatus.ASSIGNED].includes(
        h.status,
      ),
    );
    const hojaDeChofer = new Map(vivas.map((h) => [h.deliveryId, h.batchId]));
    const hojaDeAuto = new Map(vivas.map((h) => [h.carId, h.batchId]));
    const mapeadas = await this.mapear(distributorId, hojas);
    return {
      plan: planDto(plan),
      sheets: mapeadas,
      emptiesExpected: mapeadas.reduce(
        (s, h) => s + h.totals.emptiesExpected,
        0,
      ),
      unassigned: sinHoja.map((p) => sinAsignar(p, planDate)),
      resources: {
        drivers: choferes.map((c) => ({
          deliveryId: c.deliveryId,
          name: c.name,
          available: c.available,
          busySheetId: hojaDeChofer.get(c.deliveryId) ?? null,
          usualCarId: c.usualCarId,
        })),
        cars: await Promise.all(
          vehiculos.map(async (v) => ({
            carId: v.carId,
            patent: v.patent,
            description: v.description,
            capacityKg: v.capacityKg,
            capacityUnits: v.capacityUnits,
            photoUrl: await this.fotos.urlDe(v.photoKey),
            available: v.available,
            busySheetId: hojaDeAuto.get(v.carId) ?? null,
          })),
        ),
      },
    };
  }

  /**
   * Pedidos de D que entraron después del cierre y no están en ninguna hoja,
   * con la mejor inserción factible en los borradores del día (§7.3). Es una
   * sugerencia: el administrador decide.
   */
  async tardios(
    distributorId: string,
    planDate: string,
  ): Promise<LateOrderDto[]> {
    const plan = await this.plans.buscar(distributorId, planDate);
    const pedidos = (
      await this.data.pedidosSinHoja(distributorId, planDate)
    ).filter((p) => p.createdAtMs >= plan.cutoffAt.getTime());
    const borradores = await this.sheets.find({
      where: {
        distributorId,
        planDate,
        kind: RouteBatchKind.PLANNED,
        status: RouteBatchStatus.DRAFT,
      },
      order: { batchId: 'ASC' },
    });
    const params = await this.writer.parametros(distributorId);
    const sugerir = await this.writer.sugiereTardios(distributorId);
    const resultado: LateOrderDto[] = [];
    for (const p of pedidos) {
      let mejor: LateOrderDto['suggestion'] = null;
      if (sugerir && motivoNoPlanificable(p, planDate) === null) {
        for (const hoja of borradores) {
          const e = await this.writer.estado(
            this.dataSource.manager,
            hoja,
            params,
            [
              ...(
                await this.stops.find({
                  where: { batchId: hoja.batchId, active: true },
                  order: { sequence: 'ASC' },
                })
              ).map((s) => s.orderId),
              p.orderId,
            ],
            // Lectura: sin transacción no se bloquea nada.
            false,
          );
          const cand = e.escenario.stops.find((s) => s.id === p.orderId);
          if (!cand) continue;
          const r = bestInsertion(
            e.escenario.stops.filter((s) => s.id !== p.orderId),
            cand,
            {
              schedule: e.escenario.schedule,
              maxStops: params.maxStopsPerSheet,
            },
          );
          if (r.ok && (mejor === null || r.addedMinutes < mejor.addedMinutes)) {
            mejor = {
              sheetId: hoja.batchId,
              position: r.position + 1,
              addedMinutes: Math.round(r.addedMinutes),
            };
          }
        }
      }
      resultado.push({
        ...sinAsignar(p, planDate),
        createdAt: new Date(p.createdAtMs).toISOString(),
        suggestion: mejor,
      });
    }
    return resultado;
  }

  /** Llenas a cargar por garrafa (y las vacías que vuelven del canje). */
  async cargaSugerida(
    distributorId: string,
    id: string,
  ): Promise<LoadSuggestionDto> {
    await this.detalleSinMapear(distributorId, id);
    const filas: Array<{
      gasCylinderId: string;
      type: string | null;
      fullUnits: string;
      emptyUnitsBack: string;
    }> = await this.dataSource.query(
      `SELECT oi."gas_cylinder_id" AS "gasCylinderId", gc."type" AS "type",
              SUM(oi."quantity") AS "fullUnits",
              SUM(oi."quantity" - oi."containers_charged") AS "emptyUnitsBack"
         FROM "route_batch_stop" s
         JOIN "order_item" oi ON oi."order_id" = s."order_id"
         JOIN "gas_cylinder" gc ON gc."gas_cylinder_id" = oi."gas_cylinder_id"
        WHERE s."batch_id" = $1 AND s."active"
        GROUP BY oi."gas_cylinder_id", gc."type"
        ORDER BY gc."type", oi."gas_cylinder_id"`,
      [id],
    );
    return {
      sheetId: id,
      items: filas.map((f) => ({
        gasCylinderId: f.gasCylinderId,
        type: f.type,
        fullUnits: Number(f.fullUnits),
        emptyUnitsBack: Number(f.emptyUnitsBack),
      })),
    };
  }

  async detalleSinMapear(
    distributorId: string,
    id: string,
  ): Promise<RouteBatch> {
    const sheet = await this.sheets.findOne({
      where: { batchId: id, distributorId, kind: RouteBatchKind.PLANNED },
    });
    if (!sheet) throw hojaNoEncontrada();
    return sheet;
  }

  /**
   * Recalcula una hoja viva cuyos totales quedaron viejos (una parada salió sola
   * al cancelarse su pedido, o cambió la carga de un pedido): bajo el cerrojo
   * de la hoja, como cualquier edición, y sólo si con la fila tomada sigue
   * desfasada (dos lecturas a la vez no la recalculan dos veces ni le suben dos
   * veces la versión). Si otra sesión la tiene tomada, la deja como está: quien
   * la edita la recalcula al guardar.
   */
  private async refrescar(distributorId: string, id: string): Promise<void> {
    const params = await this.writer.parametros(distributorId);
    try {
      await this.locks.conHojas(
        distributorId,
        [{ id }],
        async (manager, [sheet]) => {
          // Otra lectura pudo recalcularla mientras se esperaba el cerrojo: se
          // vuelve a mirar con la fila tomada y, si ya está al día, no se escribe.
          const paradas = await this.writer.paradasActivas(
            manager,
            sheet.batchId,
          );
          const pedidos = new Map(
            (
              await this.data.pedidos(
                distributorId,
                paradas.map((x) => x.orderId),
                manager,
              )
            ).map((x) => [x.orderId, x]),
          );
          if (!totalesViejos(sheet, paradas, pedidos)) return;
          await this.writer.recalcular(manager, sheet, params);
        },
      );
    } catch (error) {
      const code = (
        error as { getResponse?: () => { code?: string } }
      ).getResponse?.()?.code;
      if (code !== ROUTE_PLAN_CODES.SHEET_BUSY) throw error;
    }
  }

  /** Hojas → DTO con sus paradas activas (o las últimas, si la hoja ya se cerró). */
  async mapear(
    distributorId: string,
    hojas: RouteBatch[],
    refrescar = true,
  ): Promise<RouteSheetDto[]> {
    if (hojas.length === 0) return [];
    const ids = hojas.map((h) => h.batchId);
    const paradas = await this.stops.find({
      where: { batchId: In(ids), active: true },
      order: { sequence: 'ASC' },
    });
    const pedidos = new Map(
      (
        await this.data.pedidos(
          distributorId,
          paradas.map((p) => p.orderId),
        )
      ).map((p) => [p.orderId, p]),
    );
    if (refrescar) {
      const viejas = hojas.filter((h) =>
        totalesViejos(
          h,
          paradas.filter((s) => s.batchId === h.batchId),
          pedidos,
        ),
      );
      if (viejas.length > 0) {
        for (const h of viejas) await this.refrescar(distributorId, h.batchId);
        const frescas = new Map(
          (
            await this.sheets.find({
              where: { batchId: In(viejas.map((h) => h.batchId)) },
            })
          ).map((h) => [h.batchId, h]),
        );
        return this.mapear(
          distributorId,
          hojas.map((h) => frescas.get(h.batchId) ?? h),
          false,
        );
      }
    }
    const choferes = new Map(
      (
        await this.data.choferes(
          distributorId,
          hojas.map((h) => h.deliveryId).filter((x): x is string => !!x),
        )
      ).map((c) => [c.deliveryId, c]),
    );
    const autos = new Map(
      (
        await this.data.vehiculos(
          distributorId,
          hojas.map((h) => h.carId).filter((x): x is string => !!x),
        )
      ).map((v) => [v.carId, v]),
    );
    const conDeposito = new Set(
      (
        await this.dataSource.query<Array<{ id: string }>>(
          `SELECT "warehouse_id" AS "id" FROM "warehouse"
          WHERE "distributor_id" = $1 AND "location" IS NOT NULL AND "deletedAt" IS NULL`,
          [distributorId],
        )
      ).map((f) => f.id),
    );
    return hojas.map((h) => {
      const propias = paradas.filter((p) => p.batchId === h.batchId);
      const auto = h.carId ? autos.get(h.carId) : undefined;
      const stops = propias.map((s) => {
        const p = pedidos.get(s.orderId);
        return {
          orderId: s.orderId,
          sequence: s.sequence,
          locked: s.sequenceLocked,
          customerName: p?.customerName ?? null,
          customerPhone: p?.customerPhone ?? null,
          address: p?.address ?? null,
          lat: p?.lat ?? null,
          lng: p?.lng ?? null,
          slotName: p?.slotName ?? null,
          slotStart: isoMs(p?.slotStartMs ?? null),
          slotEnd: isoMs(p?.slotEndMs ?? null),
          etaAt: iso(s.etaAt),
          plannedEtaAt: iso(s.plannedEtaAt),
          legDistanceKm: s.legDistanceKm,
          legDurationMin: s.legDurationMin,
          late:
            !!s.etaAt &&
            p?.slotEndMs !== null &&
            p?.slotEndMs !== undefined &&
            s.etaAt.getTime() > p.slotEndMs,
          units: p?.units ?? 0,
          emptiesExpected: p?.collectUnits ?? 0,
          weightKg: p?.weightKg ?? 0,
          unpaidOnline: p?.unpaidOnline ?? false,
        };
      });
      const noPlanificables = propias.filter((s) => {
        const p = pedidos.get(s.orderId);
        if (!p) return true;
        // Ya asignado a SU chofer (la hoja confirmada es suya): está bien.
        if (esDelChoferDeLaHoja(p, h)) return false;
        return motivoNoPlanificable(p, h.planDate as string) !== null;
      }).length;
      const capacidad = {
        kg: auto?.capacityKg ?? null,
        units: auto?.capacityUnits ?? null,
      };
      const totals = {
        distanceKm: h.totalDistanceKm ?? 0,
        durationMin: h.totalDurationMin ?? 0,
        units: h.totalUnits ?? 0,
        peakUnits: h.peakUnits ?? 0,
        weightKg: h.totalWeightKg,
        emptiesExpected: stops.reduce((s, x) => s + x.emptiesExpected, 0),
      };
      return {
        id: h.batchId,
        number: h.number,
        planDate: h.planDate as string,
        status: h.status,
        version: h.version,
        deliveryId: h.deliveryId,
        driverName: h.deliveryId
          ? (choferes.get(h.deliveryId)?.name ?? null)
          : null,
        carId: h.carId,
        carPatent: auto?.patent ?? null,
        originWarehouseId: h.originWarehouseId,
        plannedStartAt: iso(h.plannedStartAt),
        proposedBy: h.proposedBy,
        optimizationMethod: h.optimizationMethod,
        matrixSource: h.matrixSource,
        editedAt: iso(h.editedAt),
        confirmedAt: iso(h.confirmedAt),
        assignedAt: iso(h.assignedAt),
        startedAt: iso(h.startedAt),
        closedAt: iso(h.closedAt),
        closeReason: h.closeReason,
        totals,
        capacity: capacidad,
        stops,
        warnings: advertencias(
          h,
          stops,
          capacidad,
          totals,
          conDeposito,
          noPlanificables,
        ),
      };
    });
  }
}

function advertencias(
  h: RouteBatch,
  stops: Array<{ late: boolean; unpaidOnline: boolean }>,
  cap: { kg: number | null; units: number | null },
  totals: { weightKg: number; peakUnits: number },
  conDeposito: ReadonlySet<string>,
  invalidas: number,
): RouteSheetWarningDto[] {
  const w: RouteSheetWarningDto[] = [];
  const tarde = stops.filter((s) => s.late).length;
  if (tarde > 0) {
    w.push({
      code: 'late_stops',
      message: `${tarde} parada(s) llegan fuera de su franja`,
    });
  }
  if (h.carId && cap.kg === null && cap.units === null) {
    w.push({
      code: 'no_capacity',
      message: 'El vehículo no tiene capacidad cargada: no se controla el tope',
    });
  }
  if (
    (cap.kg !== null && totals.weightKg > cap.kg) ||
    (cap.units !== null && totals.peakUnits > cap.units)
  ) {
    w.push({
      code: 'capacity',
      message: 'La carga supera la capacidad del vehículo',
    });
  }
  if (h.matrixSource === RouteMatrixSource.HAVERSINE) {
    w.push({
      code: 'straight_line',
      message:
        'Tiempos estimados en línea recta: el servicio de rutas no respondió',
    });
  }
  if (!h.originWarehouseId || !conDeposito.has(h.originWarehouseId)) {
    w.push({
      code: 'no_warehouse',
      message:
        'Sin depósito de salida ubicado: el recorrido sale del centro de las paradas',
    });
  }
  // Sólo en las vivas: en una cerrada o cancelada ya no importa.
  const vivas = [RouteBatchStatus.DRAFT, RouteBatchStatus.CONFIRMED].includes(
    h.status,
  );
  if (vivas && invalidas > 0) {
    w.push({
      code: 'stops_not_plannable',
      message: `${invalidas} parada(s) con pedidos que ya no se pueden repartir en la hoja: sacalas`,
    });
  }
  const sinPagar = stops.filter((s) => s.unpaidOnline).length;
  if (sinPagar > 0) {
    w.push({
      code: 'unpaid_online',
      message: `${sinPagar} pedido(s) de Mercado Pago todavía sin pagar`,
    });
  }
  return w;
}

function planDto(p: RoutePlan): RoutePlanDto {
  return {
    date: p.planDate,
    status: p.status,
    cutoffAt: p.cutoffAt.toISOString(),
    proposedAt: iso(p.proposedAt),
    summary: p.proposalSummary,
    closedAt: iso(p.closedAt),
  };
}

function sinAsignar(p: PedidoDeHoja, fecha: string): UnassignedOrderDto {
  const motivo = motivoNoPlanificable(p, fecha);
  return {
    orderId: p.orderId,
    customerName: p.customerName,
    address: p.address,
    lat: p.lat,
    lng: p.lng,
    slotName: p.slotName,
    slotStart: isoMs(p.slotStartMs),
    slotEnd: isoMs(p.slotEndMs),
    units: p.units,
    weightKg: p.weightKg,
    blockedReason:
      motivo ??
      (p.offeredNow
        ? 'tiene una oferta del despacho esperando respuesta'
        : null),
  };
}

/**
 * Los totales guardados de una hoja viva ya no son los de sus paradas activas:
 * las garrafas que suma no coinciden con las de las paradas que entran en el
 * recorrido (con punto y franja, como en `RouteSheetCalculator`). Toda parada
 * de ésas tiene al menos una garrafa, así que una que salió siempre se nota.
 */
function totalesViejos(
  h: RouteBatch,
  paradas: readonly RouteBatchStop[],
  pedidos: ReadonlyMap<string, PedidoDeHoja>,
): boolean {
  if (
    ![RouteBatchStatus.DRAFT, RouteBatchStatus.CONFIRMED].includes(h.status)
  ) {
    return false;
  }
  const unidades = paradas.reduce((t, s) => {
    const p = pedidos.get(s.orderId);
    const enRecorrido =
      !!p &&
      p.lat !== null &&
      p.lng !== null &&
      p.slotStartMs !== null &&
      p.slotEndMs !== null;
    return t + (enRecorrido ? p.units : 0);
  }, 0);
  return unidades !== (h.totalUnits ?? 0);
}

/** El pedido ya está asignado al chofer de la hoja (la hoja confirmada de hoy le entregó sus pedidos). */
function esDelChoferDeLaHoja(p: PedidoDeHoja, h: RouteBatch): boolean {
  return (
    !!h.deliveryId &&
    p.deliveryId === h.deliveryId &&
    (p.status === 'accepted' || p.status === 'on_the_way')
  );
}
