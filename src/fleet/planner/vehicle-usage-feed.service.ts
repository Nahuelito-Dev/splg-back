import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CarService } from '../../car/car.service';
import {
  diaArgentino,
  sumarDias,
  ZONA_ARGENTINA,
} from '../../common/utils/dias-argentina';
import {
  calibrarConOdometro,
  LecturaDeOdometro,
  ParadaEntregada,
  usoDelDia,
  UsoDelDia,
} from './domain/uso-diario';

/** Días hacia atrás que se recalculan en cada corrida (una lectura de odómetro tardía recalibra el tramo). */
export const DIAS_A_RECALCULAR = 90;
/** Cuánto antes de la ventana se buscan lecturas de odómetro, para tener la que abre el primer tramo. */
const DIAS_PREVIOS_DE_LECTURAS = 60;

interface FilaDeParada {
  car_id: string;
  at: Date;
  lat: number;
  lng: number;
}

interface FilaDeLectura {
  car_id: string;
  at: Date;
  km: number;
}

export interface ResumenDeAlimentacion {
  vehiculos: number;
  filas: number;
}

/**
 * La fuente del uso real de la flota (CU-105: «a partir del recorrido que el
 * sistema ya registra en cada entrega»). Una vez por día, para cada vehículo,
 * escribe en `vehicle_usage_log` los kilómetros de cada día:
 *
 * 1. Estimado por recorrido: la distancia entre las paradas entregadas del día
 *    (en el orden en que se entregaron, con el vehículo que figura en cada
 *    pedido), por 1,3 por las calles.
 * 2. Calibrado con el odómetro: entre dos lecturas con fecha (cargas de
 *    combustible y cierres de tareas con kilometraje) la diferencia de
 *    kilómetros es lo recorrido de verdad. **Manda el odómetro** sobre el
 *    recorrido porque es una medición y el recorrido, una aproximación (no
 *    ve el camino al depósito, ni lo que se anda sin entregar). El tramo se
 *    reparte entre sus días en proporción al recorrido estimado.
 *
 * Es idempotente: cada vehículo y día se escribe con un upsert sobre
 * (vehículo, día), y se recalculan los últimos 90 días en cada corrida.
 */
@Injectable()
export class VehicleUsageFeedService {
  private readonly logger = new Logger(VehicleUsageFeedService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly carService: CarService,
  ) {}

  /** Distribuidoras con vehículos: las que el cron recorre. */
  async distribuidorasConVehiculos(): Promise<string[]> {
    const filas: Array<{ id: string }> = await this.dataSource.query(
      `SELECT DISTINCT "distributor_id" AS id FROM "car" WHERE "deletedAt" IS NULL`,
    );
    return filas.map((f) => f.id);
  }

  async alimentar(
    distributorId: string,
    ahora: Date = new Date(),
  ): Promise<ResumenDeAlimentacion> {
    const cars = await this.carService.findAll(distributorId);
    if (cars.length === 0) return { vehiculos: 0, filas: 0 };
    const carIds = cars.map((c) => c.carId);
    const hoy = diaArgentino(ahora);
    const hasta = sumarDias(hoy, -1);
    const desde = sumarDias(hoy, -DIAS_A_RECALCULAR);

    const paradas = await this.paradas(distributorId, carIds, desde, hoy);
    const lecturas = await this.lecturas(
      distributorId,
      carIds,
      sumarDias(desde, -DIAS_PREVIOS_DE_LECTURAS),
    );

    let filas = 0;
    for (const carId of carIds) {
      const porDia = new Map<string, ParadaEntregada[]>();
      for (const p of paradas.get(carId) ?? []) {
        const dia = diaArgentino(p.at);
        const lista = porDia.get(dia) ?? [];
        lista.push(p);
        porDia.set(dia, lista);
      }
      const estimados = [...porDia.entries()].map(([dia, ps]) =>
        usoDelDia(dia, ps),
      );
      const usos = calibrarConOdometro(
        estimados,
        lecturas.get(carId) ?? [],
      ).filter(
        // Un día sin recorrido medible (una sola parada, o todas en el mismo lugar) no tiene dato: no es un día de 0 km.
        (u) => u.day >= desde && u.day <= hasta && u.km > 0,
      );
      for (const uso of usos) {
        await this.escribir(distributorId, carId, uso);
        filas += 1;
      }
    }
    this.logger.log(
      `Uso de flota ${distributorId}: ${filas} día(s) de ${cars.length} vehículo(s)`,
    );
    return { vehiculos: cars.length, filas };
  }

  /** Las paradas entregadas por vehículo, con su ubicación. */
  private async paradas(
    distributorId: string,
    carIds: string[],
    desde: string,
    hasta: string,
  ): Promise<Map<string, ParadaEntregada[]>> {
    const filas: FilaDeParada[] = await this.dataSource.query(
      `SELECT "vehicle_car_id" AS car_id, "deliveredAt" AS at,
              ST_Y("deliveryPoint") AS lat, ST_X("deliveryPoint") AS lng
         FROM "order"
        WHERE "distributor_id" = $1
          AND "status" = 'delivered'
          AND "vehicle_car_id" = ANY($2::uuid[])
          AND "deliveryPoint" IS NOT NULL
          AND ("deliveredAt" AT TIME ZONE '${ZONA_ARGENTINA}')::date BETWEEN $3::date AND $4::date`,
      [distributorId, carIds, desde, hasta],
    );
    const mapa = new Map<string, ParadaEntregada[]>();
    for (const f of filas) {
      const lista = mapa.get(f.car_id) ?? [];
      lista.push({
        at: new Date(f.at),
        lat: Number(f.lat),
        lng: Number(f.lng),
      });
      mapa.set(f.car_id, lista);
    }
    return mapa;
  }

  /** Las lecturas del odómetro con fecha: cargas de combustible y tareas cerradas con kilometraje. */
  private async lecturas(
    distributorId: string,
    carIds: string[],
    desde: string,
  ): Promise<Map<string, LecturaDeOdometro[]>> {
    const filas: FilaDeLectura[] = await this.dataSource.query(
      `SELECT "car_id", "loaded_at" AS at, "odometer_km" AS km
         FROM "fuel_load"
        WHERE "distributor_id" = $1 AND "car_id" = ANY($2::uuid[])
          AND "deletedAt" IS NULL AND "loaded_at" >= $3::date
       UNION ALL
       SELECT "car_id", "performed_at" AS at, "odometer_km" AS km
         FROM "maintenance_task"
        WHERE "distributor_id" = $1 AND "car_id" = ANY($2::uuid[])
          AND "status" = 'done' AND "odometer_km" IS NOT NULL
          AND "performed_at" IS NOT NULL AND "performed_at" >= $3::date`,
      [distributorId, carIds, desde],
    );
    const mapa = new Map<string, LecturaDeOdometro[]>();
    for (const f of filas) {
      const lista = mapa.get(f.car_id) ?? [];
      lista.push({ at: new Date(f.at), km: Number(f.km) });
      mapa.set(f.car_id, lista);
    }
    return mapa;
  }

  private async escribir(
    distributorId: string,
    carId: string,
    uso: UsoDelDia,
  ): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO "vehicle_usage_log" ("car_id", "distributor_id", "day", "km", "orders", "route_hours")
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT ("car_id", "day") DO UPDATE
         SET "km" = EXCLUDED."km", "orders" = EXCLUDED."orders", "route_hours" = EXCLUDED."route_hours"`,
      [
        carId,
        distributorId,
        uso.day,
        Math.round(uso.km * 100) / 100,
        uso.orders,
        Math.round(uso.routeHours * 100) / 100,
      ],
    );
  }
}
