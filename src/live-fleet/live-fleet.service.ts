import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { diaArgentino } from '../common/utils/dias-argentina';
import { RedisService } from '../redis/redis.service';
import { EntityPhotoService } from '../s3/entity-photo.service';
import { ESTADOS_ABIERTOS } from '../truck-load/domain/truck-load.enums';
import type {
  LiveFleetDto,
  LiveVehicleDto,
  LiveVehicleLoadDto,
  LiveVehicleLocationDto,
  LiveVehicleSheetDto,
  LiveVehicleStopDto,
} from './dto/live-fleet-response.dto';
import {
  avance,
  estadoDelVehiculo,
  finEstimado,
  paradasEnVivo,
  porcentajeDeCarga,
} from './live-fleet.rules';

interface FilaVehiculo {
  carId: string;
  deliveryId: string;
  inUseSince: Date;
  patent: string | null;
  typeCar: string | null;
  description: string | null;
  capacityUnits: number | null;
  carPhotoKey: string | null;
  driverUserId: string;
  driverName: string | null;
  driverPhone: string | null;
  driverPhotoKey: string | null;
}

interface FilaStock {
  carId: string;
  full: number;
  empty: number;
  defective: number;
}

interface FilaCarga {
  carId: string;
  loadId: string;
  number: number;
  status: LiveVehicleLoadDto['truckLoadStatus'];
}

interface FilaHoja {
  sheetId: string;
  carId: string;
  deliveryId: string | null;
  number: number | null;
  status: LiveVehicleSheetDto['status'];
  planDate: string;
  startedAt: Date | null;
  plannedStartAt: Date | null;
}

interface FilaDestino {
  orderId: string;
  orderStatus: string;
  customerName: string | null;
  address: string | null;
  lat: string | number | null;
  lng: string | number | null;
}

interface FilaParada extends FilaDestino {
  sheetId: string;
  sequence: number;
  active: boolean;
  removedReason: string | null;
  removedAt: Date | null;
  etaAt: Date | null;
}

interface FilaPedido extends FilaDestino {
  deliveryId: string;
}

const DESTINO = `
       o."order_id" AS "orderId", o."status"::text AS "orderStatus", u."full_name" AS "customerName",
       COALESCE(a."formattedAddress", NULLIF(concat_ws(', ', a."street", a."city"), '')) AS "address",
       ST_Y(o."deliveryPoint") AS "lat", ST_X(o."deliveryPoint") AS "lng"`;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const numero = (v: string | number | null): number | null =>
  v === null ? null : Number(v);

function agrupar<T, K>(filas: readonly T[], clave: (f: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const f of filas) m.set(clave(f), [...(m.get(clave(f)) ?? []), f]);
  return m;
}

/**
 * Los vehículos que están en uso ahora (con un chofer que los tiene asignados),
 * cada uno con su chofer, lo que lleva a bordo contra su capacidad, la hoja de
 * ruta de hoy, sus paradas y la última posición. Modelo de lectura: sólo
 * consulta, con una cantidad fija de consultas para toda la flota.
 */
@Injectable()
export class LiveFleetService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    private readonly fotos: EntityPhotoService,
  ) {}

  async vehiculos(distributorId: string): Promise<LiveFleetDto> {
    const enUso: FilaVehiculo[] = await this.dataSource.query(
      `SELECT va."car_id" AS "carId", va."delivery_id" AS "deliveryId", va."assigned_at" AS "inUseSince",
              c."car_patent" AS "patent", c."type_car" AS "typeCar",
              NULLIF(concat_ws(' ', c."car_brand", c."car_model"), '') AS "description",
              c."max_cylinders" AS "capacityUnits", c."photo_key" AS "carPhotoKey",
              d."user_id" AS "driverUserId", u."full_name" AS "driverName",
              u."phone_number" AS "driverPhone", u."photo_key" AS "driverPhotoKey"
         FROM "vehicle_assignment" va
         JOIN "car" c ON c."car_id" = va."car_id" AND c."distributor_id" = va."distributor_id"
         JOIN "delivery" d ON d."delivery_id" = va."delivery_id" AND d."distributor_id" = va."distributor_id"
         JOIN "user" u ON u."user_id" = d."user_id"
        WHERE va."distributor_id" = $1 AND va."released_at" IS NULL AND c."deletedAt" IS NULL
        ORDER BY c."car_patent" NULLS LAST, c."car_id"`,
      [distributorId],
    );
    if (enUso.length === 0) {
      return { generatedAt: new Date().toISOString(), vehicles: [] };
    }
    const carIds = enUso.map((v) => v.carId);
    const deliveryIds = enUso.map((v) => v.deliveryId);
    const [
      stock,
      cargas,
      hojas,
      pedidos,
      posiciones,
      fotosDeAutos,
      fotosDeChoferes,
    ] = await Promise.all([
      this.stock(distributorId, carIds),
      this.cargas(distributorId, carIds),
      this.hojas(distributorId, carIds),
      this.pedidosEnCurso(distributorId, deliveryIds),
      this.posiciones(enUso.map((v) => v.driverUserId)),
      Promise.all(enUso.map((v) => this.fotos.urlDe(v.carPhotoKey))),
      Promise.all(enUso.map((v) => this.fotos.urlDe(v.driverPhotoKey))),
    ]);
    // La hoja cuenta sólo si es de quien tiene el vehículo ahora.
    const hojaDe = new Map<string, FilaHoja>();
    for (const v of enUso) {
      const hoja = hojas.get(v.carId);
      if (hoja && hoja.deliveryId === v.deliveryId) hojaDe.set(v.carId, hoja);
    }
    const paradas = agrupar(
      await this.paradas(
        distributorId,
        [...hojaDe.values()].map((h) => h.sheetId),
      ),
      (p) => p.sheetId,
    );
    const pedidosDe = agrupar(pedidos, (p) => p.deliveryId);

    const vehicles = enUso.map((v, i): LiveVehicleDto => {
      const hoja = hojaDe.get(v.carId) ?? null;
      const filas = hoja ? (paradas.get(hoja.sheetId) ?? []) : [];
      const destino = new Map(filas.map((f) => [f.orderId, f]));
      const deHoja = paradasEnVivo(filas, hoja?.startedAt ?? null);
      const enHoja = new Set(deHoja.map((p) => p.orderId));
      const sueltos = (pedidosDe.get(v.deliveryId) ?? []).filter(
        (p) => !enHoja.has(p.orderId),
      );
      const stops: LiveVehicleStopDto[] = [
        ...deHoja.map((p) => ({
          ...this.destino(destino.get(p.orderId)),
          orderId: p.orderId,
          source: 'route_sheet' as const,
          sequence: p.sequence,
          progress: p.progress,
          etaAt: iso(p.etaAt),
        })),
        ...sueltos.map((p) => ({
          ...this.destino(p),
          orderId: p.orderId,
          source: 'order' as const,
          sequence: null,
          progress:
            p.orderStatus === 'on_the_way'
              ? ('on_the_way' as const)
              : ('pending' as const),
          etaAt: null,
        })),
      ];
      const enCalle = stock.get(v.carId);
      const carga = cargas.get(v.carId);
      const aBordo =
        (enCalle?.full ?? 0) +
        (enCalle?.empty ?? 0) +
        (enCalle?.defective ?? 0);
      return {
        carId: v.carId,
        patent: v.patent,
        typeCar: v.typeCar,
        description: v.description,
        photoUrl: fotosDeAutos[i],
        status: estadoDelVehiculo(
          hoja?.status === 'assigned' && hoja.startedAt !== null,
          sueltos.length,
        ),
        inUseSince: v.inUseSince.toISOString(),
        driver: {
          deliveryId: v.deliveryId,
          userId: v.driverUserId,
          name: v.driverName,
          phone: v.driverPhone,
          photoUrl: fotosDeChoferes[i],
        },
        load: {
          truckLoadId: carga?.loadId ?? null,
          truckLoadNumber: carga?.number ?? null,
          truckLoadStatus: carga?.status ?? null,
          fullUnits: enCalle?.full ?? 0,
          emptyUnits: enCalle?.empty ?? 0,
          defectiveUnits: enCalle?.defective ?? 0,
          unitsOnBoard: aBordo,
          capacityUnits: v.capacityUnits,
          percent: porcentajeDeCarga(aBordo, v.capacityUnits),
        },
        sheet: hoja
          ? {
              id: hoja.sheetId,
              number: hoja.number,
              status: hoja.status,
              planDate: hoja.planDate,
              plannedStartAt: iso(hoja.plannedStartAt),
              startedAt: iso(hoja.startedAt),
              ...avance(deHoja),
              estimatedEndAt: iso(finEstimado(deHoja)),
            }
          : null,
        stops,
        location: posiciones.get(v.driverUserId) ?? null,
      };
    });
    // El orden por patente viene de la consulta; `sort` es estable.
    vehicles.sort(
      (a, b) =>
        Number(b.status === 'on_route') - Number(a.status === 'on_route'),
    );
    return { generatedAt: new Date().toISOString(), vehicles };
  }

  private destino(
    f: FilaDestino | undefined,
  ): Pick<LiveVehicleStopDto, 'customerName' | 'address' | 'lat' | 'lng'> {
    return {
      customerName: f?.customerName ?? null,
      address: f?.address ?? null,
      lat: numero(f?.lat ?? null),
      lng: numero(f?.lng ?? null),
    };
  }

  /** Lo que cada vehículo tiene a bordo ahora, por condición. */
  private async stock(
    distributorId: string,
    carIds: string[],
  ): Promise<Map<string, FilaStock>> {
    const filas: FilaStock[] = await this.dataSource.query(
      `SELECT l."car_id" AS "carId",
              COALESCE(SUM(b."quantity") FILTER (WHERE b."condition" = 'full'), 0)::int AS "full",
              COALESCE(SUM(b."quantity") FILTER (WHERE b."condition" = 'empty'), 0)::int AS "empty",
              COALESCE(SUM(b."quantity") FILTER (WHERE b."condition" = 'defective'), 0)::int AS "defective"
         FROM "stock_balance" b
         JOIN "stock_location" l ON l."location_id" = b."location_id"
        WHERE l."distributor_id" = $1 AND l."car_id" = ANY($2::uuid[]) AND b."quantity" > 0
        GROUP BY l."car_id"`,
      [distributorId, carIds],
    );
    return new Map(filas.map((f) => [f.carId, f]));
  }

  /** La carga abierta de cada vehículo (hay a lo sumo una). */
  private async cargas(
    distributorId: string,
    carIds: string[],
  ): Promise<Map<string, FilaCarga>> {
    const filas: FilaCarga[] = await this.dataSource.query(
      `SELECT "car_id" AS "carId", "load_id" AS "loadId", "number", "status"::text AS "status"
         FROM "truck_load"
        WHERE "distributor_id" = $1 AND "car_id" = ANY($2::uuid[]) AND "status"::text = ANY($3::text[])`,
      [distributorId, carIds, ESTADOS_ABIERTOS],
    );
    return new Map(filas.map((f) => [f.carId, f]));
  }

  /** La hoja de cada vehículo: la que está en curso o, si no, la confirmada de hoy. */
  private async hojas(
    distributorId: string,
    carIds: string[],
  ): Promise<Map<string, FilaHoja>> {
    const filas: FilaHoja[] = await this.dataSource.query(
      `SELECT DISTINCT ON (b."car_id") b."batch_id" AS "sheetId", b."car_id" AS "carId",
              b."delivery_id" AS "deliveryId", b."number", b."status"::text AS "status",
              to_char(b."plan_date", 'YYYY-MM-DD') AS "planDate", b."started_at" AS "startedAt", b."planned_start_at" AS "plannedStartAt"
         FROM "route_batch" b
        WHERE b."distributor_id" = $1 AND b."kind" = 'planned' AND b."car_id" = ANY($2::uuid[])
          AND (b."status" = 'assigned' OR (b."status" = 'confirmed' AND b."plan_date" = $3::date))
        ORDER BY b."car_id", (b."status" = 'assigned') DESC, b."planned_start_at" NULLS LAST, b."batch_id"`,
      [distributorId, carIds, diaArgentino()],
    );
    return new Map(filas.map((f) => [f.carId, f]));
  }

  private async paradas(
    distributorId: string,
    sheetIds: string[],
  ): Promise<FilaParada[]> {
    if (sheetIds.length === 0) return [];
    return this.dataSource.query(
      `SELECT s."batch_id" AS "sheetId", s."sequence", s."active", s."removed_reason"::text AS "removedReason",
              s."removed_at" AS "removedAt", s."eta_at" AS "etaAt",${DESTINO}
         FROM "route_batch_stop" s
         JOIN "order" o ON o."order_id" = s."order_id" AND o."distributor_id" = $1
         LEFT JOIN "user" u ON u."user_id" = o."customer_id"
         LEFT JOIN "user_address" a ON a."address_id" = o."address_id"
        WHERE s."batch_id" = ANY($2::uuid[])
        ORDER BY s."batch_id", s."sequence"`,
      [distributorId, sheetIds],
    );
  }

  /** Pedidos aceptados o en camino de esos choferes: primero el que está en camino. */
  private async pedidosEnCurso(
    distributorId: string,
    deliveryIds: string[],
  ): Promise<FilaPedido[]> {
    return this.dataSource.query(
      `SELECT o."delivery_id" AS "deliveryId",${DESTINO}
         FROM "order" o
         LEFT JOIN "user" u ON u."user_id" = o."customer_id"
         LEFT JOIN "user_address" a ON a."address_id" = o."address_id"
        WHERE o."distributor_id" = $1 AND o."delivery_id" = ANY($2::uuid[])
          AND o."status"::text IN ('accepted', 'on_the_way')
        ORDER BY o."delivery_id", (o."status"::text = 'on_the_way') DESC, o."createdAt", o."order_id"`,
      [distributorId, deliveryIds],
    );
  }

  /**
   * La última posición de todos los choferes en una lectura por lote (dos idas
   * a Redis para toda la flota). Nunca rompe la respuesta: si el radar no
   * contesta, salen todas `null`.
   */
  private async posiciones(
    driverUserIds: string[],
  ): Promise<Map<string, LiveVehicleLocationDto>> {
    try {
      return await this.redis.getDriversLastLocations(driverUserIds);
    } catch {
      return new Map();
    }
  }
}
