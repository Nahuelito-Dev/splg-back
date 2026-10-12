import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

export interface ExistenciaEnUbicacion {
  locationName: string;
  quantity: number;
}

/**
 * Lecturas de existencias para otros módulos (compras: costo promedio y
 * explicación de una anulación). Sólo SELECT; no toma locks: quien lo llama ya
 * tiene los de la operación.
 */
@Injectable()
export class StockOnHandService {
  /** Llenas de la garrafa en todos los depósitos y camiones de la distribuidora. */
  async llenasTotales(
    manager: EntityManager,
    distributorId: string,
    gasCylinderId: string,
  ): Promise<number> {
    const [fila]: Array<{ total: number }> = await manager.query(
      `SELECT COALESCE(SUM("quantity"), 0)::int AS total
       FROM "stock_balance"
       WHERE "distributor_id" = $1 AND "gas_cylinder_id" = $2 AND "condition" = 'full'`,
      [distributorId, gasCylinderId],
    );
    return fila.total;
  }

  /** Dónde están hoy las llenas de la garrafa, de más a menos. */
  async dondeEstanLasLlenas(
    manager: EntityManager,
    distributorId: string,
    gasCylinderId: string,
  ): Promise<ExistenciaEnUbicacion[]> {
    const filas: Array<{ name: string; quantity: number }> =
      await manager.query(
        `SELECT COALESCE(w."name", 'vehículo ' || COALESCE(c."car_patent", l."car_id"::text)) AS name,
                b."quantity"
         FROM "stock_balance" b
         JOIN "stock_location" l ON l."location_id" = b."location_id"
         LEFT JOIN "warehouse" w ON w."warehouse_id" = l."warehouse_id"
         LEFT JOIN "car" c ON c."car_id" = l."car_id"
         WHERE b."distributor_id" = $1 AND b."gas_cylinder_id" = $2
           AND b."condition" = 'full' AND b."quantity" > 0
         ORDER BY b."quantity" DESC, name`,
        [distributorId, gasCylinderId],
      );
    return filas.map((f) => ({ locationName: f.name, quantity: f.quantity }));
  }
}
