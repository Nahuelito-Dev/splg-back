import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ESTADOS_ABIERTOS, TruckLoadStatus } from '../domain/truck-load.enums';

/** La carga abierta de un chofer, con las llenas que tiene hoy el camión. */
export interface CargaAbiertaDelChofer {
  loadId: string;
  number: number;
  status: TruckLoadStatus;
  carId: string;
  carPatent: string | null;
  /** Llenas en el camión ahora, por garrafa (saldo del libro de stock). */
  fullOnTruck: Map<string, number>;
}

/**
 * Lectura de la carga del camión para otros módulos (la hoja de ruta la cruza
 * al iniciar, F34 §8.1). Sólo lee: el libro y la rendición siguen siendo de
 * este módulo.
 */
@Injectable()
export class TruckLoadLookupService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async cargaAbiertaDelChofer(
    distributorId: string,
    deliveryId: string,
  ): Promise<CargaAbiertaDelChofer | null> {
    const [carga]: Array<{
      load_id: string;
      number: number;
      status: TruckLoadStatus;
      car_id: string;
      car_patent: string | null;
    }> = await this.dataSource.query(
      `SELECT l."load_id", l."number", l."status"::text AS "status", l."car_id", c."car_patent"
         FROM "truck_load" l
         JOIN "car" c ON c."car_id" = l."car_id"
        WHERE l."distributor_id" = $1 AND l."delivery_id" = $2
          AND l."status"::text = ANY($3::text[])
        LIMIT 1`,
      [distributorId, deliveryId, ESTADOS_ABIERTOS],
    );
    if (!carga) return null;
    const saldos: Array<{ gas_cylinder_id: string; quantity: number }> =
      await this.dataSource.query(
        `SELECT b."gas_cylinder_id", SUM(b."quantity")::int AS "quantity"
           FROM "stock_balance" b
           JOIN "stock_location" sl ON sl."location_id" = b."location_id"
          WHERE sl."car_id" = $1 AND sl."distributor_id" = $2
            AND b."condition" = 'full' AND b."quantity" > 0
          GROUP BY b."gas_cylinder_id"`,
        [carga.car_id, distributorId],
      );
    return {
      loadId: carga.load_id,
      number: carga.number,
      status: carga.status,
      carId: carga.car_id,
      carPatent: carga.car_patent,
      fullOnTruck: new Map(saldos.map((s) => [s.gas_cylinder_id, s.quantity])),
    };
  }
}
