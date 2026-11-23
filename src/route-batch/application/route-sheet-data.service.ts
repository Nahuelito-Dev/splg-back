import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { FleetDispatchLockService } from '../../fleet/fleet-dispatch-lock.service';
import { efectivoDelPedido } from '../../order/domain/efectivo-a-cobrar';
import { StopLoad } from '../domain/load-profile';
import {
  PedidoParaPlanificar,
  instanteDelDia,
} from '../domain/route-sheet-rules';

/** Un pedido con lo que la hoja necesita: punto, franja, carga y datos de la parada. */
export interface PedidoDeHoja extends PedidoParaPlanificar {
  orderId: string;
  lat: number | null;
  lng: number | null;
  /**
   * La franja de la parada en ms: la comprada, o —sin franja fija (un pedido
   * reprogramado por la hoja, o agendado sólo con fecha)— la jornada de la
   * distribuidora (de la primera a la última franja activa), así el planificador
   * calcula la hora dentro del día.
   */
  slotStartMs: number | null;
  slotEndMs: number | null;
  slotName: string | null;
  /** Tiene una franja comprada (si no, `slotStartMs`/`slotEndMs` son la jornada). */
  fixedSlot: boolean;
  /** La jornada de la distribuidora ese día (null sin franjas activas o sin fecha). */
  dayStartMs: number | null;
  dayEndMs: number | null;
  createdAtMs: number;
  customerName: string | null;
  customerPhone: string | null;
  address: string | null;
  units: number;
  weightKg: number;
  /** Vacías que se levantan en el canje (las garrafas que no se cobraron como envase). */
  collectUnits: number;
  /** Mercado Pago todavía sin pagar: entra con advertencia (D-06). */
  unpaidOnline: boolean;
  /** Efectivo que se cobra en la parada (calculado en el back); `null` si no hay. */
  cashToCollect: number | null;
  /** Tiene una oferta del despacho individual esperando respuesta. */
  offeredNow: boolean;
  /** Lote u hoja viva en la que ya está (parada activa). */
  activeBatchId: string | null;
}

export interface Deposito {
  warehouseId: string | null;
  lat: number;
  lng: number;
}

export interface ChoferDelDia {
  deliveryId: string;
  userId: string;
  name: string | null;
  available: boolean;
  /** Vehículo en uso hoy (asignación abierta) o el habitual (`car.user_id`). */
  usualCarId: string | null;
}

export interface VehiculoDelDia {
  carId: string;
  patent: string | null;
  description: string | null;
  capacityKg: number | null;
  capacityUnits: number | null;
  available: boolean;
  /** Clave de la foto en el bucket; quien arma la respuesta la firma. */
  photoKey: string | null;
}

interface FilaPedido {
  orderId: string;
  status: string;
  deliveryId: string | null;
  scheduledDate: string | null;
  slotStart: string | null;
  slotEnd: string | null;
  slotName: string | null;
  dayStart: string | null;
  dayEnd: string | null;
  deliveryMode: string;
  depositPaid: boolean;
  fraudHold: boolean;
  lat: string | null;
  lng: string | null;
  createdAtMs: string;
  customerName: string | null;
  customerPhone: string | null;
  address: string | null;
  units: string;
  weightKg: string;
  collectUnits: string;
  unpaidOnline: boolean;
  offeredNow: boolean;
  activeBatchId: string | null;
  paymentMethod: string;
  paymentStatus: string;
  totalAmount: string;
  depositAmount: string;
}

const SELECT_PEDIDO = `
  SELECT o."order_id" AS "orderId", o."status"::text AS "status", o."delivery_id" AS "deliveryId",
         to_char(o."scheduled_date", 'YYYY-MM-DD') AS "scheduledDate",
         ts."startTime"::text AS "slotStart", ts."endTime"::text AS "slotEnd", ts."name" AS "slotName",
         (SELECT min(j."startTime")::text FROM "time_slot" j
           WHERE j."distributor_id" = o."distributor_id" AND j."isActive") AS "dayStart",
         (SELECT max(j."endTime")::text FROM "time_slot" j
           WHERE j."distributor_id" = o."distributor_id" AND j."isActive") AS "dayEnd",
         o."delivery_mode"::text AS "deliveryMode", COALESCE(o."deposit_paid", false) AS "depositPaid",
         COALESCE(o."payment_fraud_hold", false) AS "fraudHold",
         ST_Y(o."deliveryPoint") AS "lat", ST_X(o."deliveryPoint") AS "lng",
         EXTRACT(EPOCH FROM o."createdAt") * 1000 AS "createdAtMs",
         u."full_name" AS "customerName", u."phone_number" AS "customerPhone",
         COALESCE(a."formattedAddress", NULLIF(concat_ws(', ', a."street", a."city"), '')) AS "address",
         COALESCE((SELECT SUM(oi."quantity") FROM "order_item" oi WHERE oi."order_id" = o."order_id"), 0) AS "units",
         COALESCE((SELECT SUM(oi."quantity" * gc."weight") FROM "order_item" oi
                     JOIN "gas_cylinder" gc ON gc."gas_cylinder_id" = oi."gas_cylinder_id"
                    WHERE oi."order_id" = o."order_id"), 0) AS "weightKg",
         COALESCE((SELECT SUM(oi."quantity" - oi."containers_charged") FROM "order_item" oi
                    WHERE oi."order_id" = o."order_id"), 0) AS "collectUnits",
         (o."paymentMethod"::text = 'mercadopago' AND o."paymentStatus"::text <> 'paid'
            AND NOT COALESCE(o."deposit_paid", false)) AS "unpaidOnline",
         o."paymentMethod"::text AS "paymentMethod", o."paymentStatus"::text AS "paymentStatus",
         o."totalAmount"::text AS "totalAmount", COALESCE(o."deposit_amount", 0)::text AS "depositAmount",
         EXISTS (SELECT 1 FROM "order_dispatch_offer" d
                  WHERE d."order_id" = o."order_id" AND d."status" = 'offered') AS "offeredNow",
         (SELECT s."batch_id" FROM "route_batch_stop" s
           WHERE s."order_id" = o."order_id" AND s."active" LIMIT 1) AS "activeBatchId"
    FROM "order" o
    LEFT JOIN "time_slot" ts ON ts."time_slot_id" = o."time_slot_id"
    LEFT JOIN "user" u ON u."user_id" = o."customer_id"
    LEFT JOIN "user_address" a ON a."address_id" = o."address_id"`;

function aPedido(f: FilaPedido): PedidoDeHoja {
  const fecha = f.scheduledDate;
  const fija = f.slotStart !== null && f.slotEnd !== null;
  const dayStartMs =
    fecha && f.dayStart ? instanteDelDia(fecha, f.dayStart) : null;
  const dayEndMs = fecha && f.dayEnd ? instanteDelDia(fecha, f.dayEnd) : null;
  const deLaFranja = (hora: string | null): number | null =>
    fecha && hora ? instanteDelDia(fecha, hora) : null;
  return {
    orderId: f.orderId,
    status: f.status,
    deliveryId: f.deliveryId,
    scheduledDate: fecha,
    hasSlot: fija || (dayStartMs !== null && dayEndMs !== null),
    deliveryMode: f.deliveryMode,
    depositPaid: f.depositPaid,
    fraudHold: f.fraudHold,
    hasPoint: f.lat !== null && f.lng !== null,
    lat: f.lat === null ? null : Number(f.lat),
    lng: f.lng === null ? null : Number(f.lng),
    slotStartMs: fija ? deLaFranja(f.slotStart) : dayStartMs,
    slotEndMs: fija ? deLaFranja(f.slotEnd) : dayEndMs,
    slotName: f.slotName,
    fixedSlot: fija,
    dayStartMs,
    dayEndMs,
    createdAtMs: Number(f.createdAtMs),
    customerName: f.customerName,
    customerPhone: f.customerPhone,
    address: f.address,
    units: Number(f.units),
    weightKg: Math.round(Number(f.weightKg) * 100) / 100,
    collectUnits: Number(f.collectUnits),
    unpaidOnline: f.unpaidOnline,
    cashToCollect: efectivoDelPedido({
      paymentMethod: f.paymentMethod,
      paymentStatus: f.paymentStatus,
      status: f.status,
      totalAmount: f.totalAmount,
      depositAmount: f.depositAmount,
      depositPaid: f.depositPaid,
    }),
    offeredNow: f.offeredNow,
    activeBatchId: f.activeBatchId,
  };
}

/** La carga de la parada: entrega las llenas y levanta las vacías del canje. */
export function cargaDelPedido(p: PedidoDeHoja): StopLoad {
  return {
    deliverUnits: p.units,
    deliverKg: p.weightKg,
    collectUnits: p.collectUnits,
    // `gas_cylinder.weight` es el contenido: la vacía no lleva gas (D-03, R-06).
    collectKg: 0,
    // Los retiros de M5 se suman en E4 (cruce con el recupero).
    pickupUnits: 0,
    pickupKg: 0,
  };
}

/**
 * Lecturas de la hoja de ruta: pedidos, depósito, choferes y vehículos. Todo
 * filtra por la distribuidora: lo ajeno no se ve (y el llamador responde 404).
 */
@Injectable()
export class RouteSheetDataService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly fleet: FleetDispatchLockService,
  ) {}

  /**
   * Los pedidos de la distribuidora con esos ids (los ajenos no vienen). Con
   * `bloquear`, toma las filas de los pedidos (`FOR UPDATE`, en orden de id para
   * no trabarse con otra transacción): el alta de una parada no se cruza con una
   * asignación manual ni con la propuesta, que bloquean las mismas filas.
   */
  async pedidos(
    distributorId: string,
    orderIds: readonly string[],
    manager: EntityManager = this.dataSource.manager,
    bloquear = false,
  ): Promise<PedidoDeHoja[]> {
    if (orderIds.length === 0) return [];
    const filas: FilaPedido[] = await manager.query(
      `${SELECT_PEDIDO}
        WHERE o."distributor_id" = $1 AND o."order_id" = ANY($2::uuid[])${bloquear ? '\n        ORDER BY o."order_id" FOR UPDATE OF o' : ''}`,
      [distributorId, orderIds],
    );
    return filas.map(aPedido);
  }

  /**
   * Los pedidos de ese día que todavía no tienen chofer ni están en una hoja o
   * lote: los candidatos de la propuesta y la columna «Sin asignar».
   */
  async pedidosSinHoja(
    distributorId: string,
    fecha: string,
    /** Hojas cuyos pedidos cuentan como libres (los borradores que la re-propuesta rehace). */
    liberables: readonly string[] = [],
  ): Promise<PedidoDeHoja[]> {
    const filas: FilaPedido[] = await this.dataSource.query(
      `${SELECT_PEDIDO}
        WHERE o."distributor_id" = $1 AND o."scheduled_date" = $2::date
          AND o."delivery_id" IS NULL
          AND o."status"::text IN ('pending', 'reserved')
          AND NOT EXISTS (SELECT 1 FROM "route_batch_stop" s
                           WHERE s."order_id" = o."order_id" AND s."active"
                             AND NOT (s."batch_id" = ANY($3::uuid[])))
        ORDER BY ts."startTime" NULLS LAST, o."createdAt", o."order_id"`,
      [distributorId, fecha, liberables],
    );
    return filas.map(aPedido);
  }

  /**
   * De dónde sale el recorrido: el depósito pedido (si es de la distribuidora y
   * tiene ubicación) o el predeterminado. `null` si no hay ninguno ubicado.
   */
  async deposito(
    distributorId: string,
    warehouseId: string | null,
  ): Promise<Deposito | null> {
    const filas: Array<{ warehouseId: string; lat: string; lng: string }> =
      await this.dataSource.query(
        `SELECT w."warehouse_id" AS "warehouseId", ST_Y(w."location") AS "lat", ST_X(w."location") AS "lng"
           FROM "warehouse" w
          WHERE w."distributor_id" = $1 AND w."deletedAt" IS NULL AND w."location" IS NOT NULL
            AND ($2::uuid IS NULL OR w."warehouse_id" = $2::uuid)
          ORDER BY w."is_default" DESC, w."warehouse_id"
          LIMIT 1`,
        [distributorId, warehouseId],
      );
    const f = filas[0];
    return f
      ? { warehouseId: f.warehouseId, lat: Number(f.lat), lng: Number(f.lng) }
      : null;
  }

  async existeDeposito(
    distributorId: string,
    warehouseId: string,
  ): Promise<boolean> {
    const filas: unknown[] = await this.dataSource.query(
      `SELECT 1 FROM "warehouse" WHERE "warehouse_id" = $1 AND "distributor_id" = $2 AND "deletedAt" IS NULL`,
      [warehouseId, distributorId],
    );
    return filas.length > 0;
  }

  /**
   * Los choferes de la distribuidora y si están en condiciones de repartir. Con
   * `fecha` (la del plan), la habilitación se evalúa a ese día (licencias,
   * vencimientos y legajo; no exige un vehículo en uso porque la hoja trae el
   * suyo). Sin fecha, la del despacho de ahora.
   */
  async choferes(
    distributorId: string,
    deliveryIds?: readonly string[],
    fecha?: string,
  ): Promise<ChoferDelDia[]> {
    const filas: Array<{
      deliveryId: string;
      userId: string;
      name: string | null;
      enabled: boolean;
      usualCarId: string | null;
    }> = await this.dataSource.query(
      `SELECT d."delivery_id" AS "deliveryId", d."user_id" AS "userId", u."full_name" AS "name",
              (d."isEnabled" AND d."validated" AND d."deletedAt" IS NULL AND u."deletedAt" IS NULL) AS "enabled",
              COALESCE(
                (SELECT va."car_id" FROM "vehicle_assignment" va
                  WHERE va."delivery_id" = d."delivery_id" AND va."released_at" IS NULL LIMIT 1),
                (SELECT c."car_id" FROM "car" c
                  WHERE c."user_id" = d."user_id" AND c."distributor_id" = d."distributor_id"
                    AND c."deletedAt" IS NULL ORDER BY c."car_id" LIMIT 1)
              ) AS "usualCarId"
         FROM "delivery" d
         JOIN "user" u ON u."user_id" = d."user_id"
        WHERE d."distributor_id" = $1
          AND ($2::uuid[] IS NULL OR d."delivery_id" = ANY($2::uuid[]))
        ORDER BY u."full_name" NULLS LAST, d."delivery_id"`,
      [distributorId, deliveryIds ?? null],
    );
    const habilitados = filas.filter((f) => f.enabled).map((f) => f.userId);
    const inhabilitados =
      habilitados.length === 0
        ? new Set<string>()
        : fecha
          ? new Set(
              (
                await this.fleet.habilitacionAlDia(
                  habilitados,
                  [],
                  distributorId,
                  fecha,
                )
              ).choferes.keys(),
            )
          : await this.fleet.choferesInhabilitados(habilitados, distributorId);
    return filas.map((f) => ({
      deliveryId: f.deliveryId,
      userId: f.userId,
      name: f.name,
      available: f.enabled && !inhabilitados.has(f.userId),
      usualCarId: f.usualCarId,
    }));
  }

  /**
   * Los vehículos vigentes de la distribuidora con su capacidad (D-03). Con
   * `fecha`, además, no está disponible el que ese día tiene un seguro o una
   * VTV vencidos o el taller programado.
   */
  async vehiculos(
    distributorId: string,
    carIds?: readonly string[],
    fecha?: string,
  ): Promise<VehiculoDelDia[]> {
    const filas: Array<{
      carId: string;
      patent: string | null;
      description: string | null;
      maxLoadKg: string | null;
      carCapacity: number | null;
      maxCylinders: number | null;
      available: boolean;
      photoKey: string | null;
    }> = await this.dataSource.query(
      `SELECT c."car_id" AS "carId", c."car_patent" AS "patent",
              NULLIF(concat_ws(' ', c."type_car", c."car_brand", c."car_model"), '') AS "description",
              c."max_load_kg" AS "maxLoadKg", c."car_capacity" AS "carCapacity",
              c."max_cylinders" AS "maxCylinders", c."photo_key" AS "photoKey",
              (c."deletedAt" IS NULL AND c."fleet_status"::text = 'active') AS "available"
         FROM "car" c
        WHERE c."distributor_id" = $1
          AND ($2::uuid[] IS NULL OR c."car_id" = ANY($2::uuid[]))
          AND ($2::uuid[] IS NOT NULL OR c."deletedAt" IS NULL)
        ORDER BY c."car_patent" NULLS LAST, c."car_id"`,
      [distributorId, carIds ?? null],
    );
    const activos = filas.filter((f) => f.available).map((f) => f.carId);
    const bloqueados =
      fecha && activos.length > 0
        ? (
            await this.fleet.habilitacionAlDia(
              [],
              activos,
              distributorId,
              fecha,
            )
          ).vehiculos
        : new Map<string, string[]>();
    return filas.map((f) => ({
      carId: f.carId,
      patent: f.patent,
      description: f.description,
      capacityKg:
        f.maxLoadKg !== null
          ? Number(f.maxLoadKg)
          : f.carCapacity !== null
            ? Number(f.carCapacity)
            : null,
      capacityUnits: f.maxCylinders,
      available: f.available && !bloqueados.has(f.carId),
      photoKey: f.photoKey,
    }));
  }

  /** Choferes y vehículos que ya tienen una hoja confirmada o en curso ese día (salvo `exceptoBatchId`). */
  async ocupadosDelDia(
    distributorId: string,
    fecha: string,
    exceptoBatchId: string | null,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<{ deliveryIds: Set<string>; carIds: Set<string> }> {
    const filas: Array<{ deliveryId: string | null; carId: string | null }> =
      await manager.query(
        `SELECT "delivery_id" AS "deliveryId", "car_id" AS "carId" FROM "route_batch"
          WHERE "distributor_id" = $1 AND "kind" = 'planned' AND "plan_date" = $2::date
            AND "status" IN ('confirmed', 'assigned')
            AND ($3::uuid IS NULL OR "batch_id" <> $3::uuid)`,
        [distributorId, fecha, exceptoBatchId],
      );
    return {
      deliveryIds: new Set(
        filas.map((f) => f.deliveryId).filter((x): x is string => !!x),
      ),
      carIds: new Set(
        filas.map((f) => f.carId).filter((x): x is string => !!x),
      ),
    };
  }
}
