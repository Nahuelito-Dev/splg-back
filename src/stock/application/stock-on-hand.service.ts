import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { claveDeSaldo } from '../domain/stock-rules';
import { StockCondition } from '../domain/stock.enums';

export interface ExistenciaEnUbicacion {
  locationName: string;
  quantity: number;
}

/** Lo entregado y recolectado por un camión desde un instante, por garrafa. */
export interface MovimientoDeCamion {
  gasCylinderId: string;
  /** Llenas que salieron del camión por entregas (netas de contraasientos). */
  deliveredFull: number;
  /** Vacías que entraron al camión por entregas (netas de contraasientos). */
  collectedEmpty: number;
}

/**
 * Lecturas de existencias para otros módulos (compras: costo promedio y
 * explicación de una anulación; carga del camión: lo entregado y el cierre).
 * Sólo toma locks `bloquearParaRendicion`, que sigue el orden global del
 * ledger; el resto es SELECT y quien lo llama ya tiene los de la operación.
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

  /** Garrafas de las que la ubicación tiene saldo (llenas, vacías o defectuosas). */
  async tiposConSaldo(
    manager: EntityManager,
    locationId: string,
  ): Promise<string[]> {
    const filas: Array<{ gas_cylinder_id: string }> = await manager.query(
      `SELECT DISTINCT "gas_cylinder_id" FROM "stock_balance"
       WHERE "location_id" = $1 AND "quantity" > 0`,
      [locationId],
    );
    return filas.map((f) => f.gas_cylinder_id);
  }

  /**
   * Lo que un camión entregó y recolectó desde `desde`: sus movimientos
   * `delivery` (salen del camión) y `empty_collected` (entran al camión), menos
   * los contraasientos de esos mismos movimientos.
   */
  async movimientosDelCamion(
    manager: EntityManager,
    truckLocationId: string,
    desde: Date,
  ): Promise<MovimientoDeCamion[]> {
    const filas: Array<{
      gas_cylinder_id: string;
      delivered: number;
      collected: number;
    }> = await manager.query(
      `SELECT m."gas_cylinder_id",
              COALESCE(SUM(CASE
                WHEN m."reason" = 'delivery' AND m."from_location_id" = $1 THEN m."quantity"
                WHEN m."reason" = 'reversal' AND o."reason" = 'delivery' AND o."from_location_id" = $1 THEN -m."quantity"
                ELSE 0 END), 0)::int AS delivered,
              COALESCE(SUM(CASE
                WHEN m."reason" = 'empty_collected' AND m."to_location_id" = $1 THEN m."quantity"
                WHEN m."reason" = 'reversal' AND o."reason" = 'empty_collected' AND o."to_location_id" = $1 THEN -m."quantity"
                ELSE 0 END), 0)::int AS collected
       FROM "stock_movement" m
       LEFT JOIN "stock_movement" o ON o."movement_id" = m."reversed_movement_id"
       WHERE m."occurred_at" >= $2
         AND (m."from_location_id" = $1 OR m."to_location_id" = $1)
       GROUP BY m."gas_cylinder_id"`,
      [truckLocationId, desde],
    );
    return filas.map((f) => ({
      gasCylinderId: f.gas_cylinder_id,
      deliveredFull: f.delivered,
      collectedEmpty: f.collected,
    }));
  }

  /**
   * Toma, en el orden global del ledger, todo lo que la rendición de un camión
   * va a tocar, y devuelve los saldos ya bajo lock (clave `claveDeSaldo`):
   *  1. `gas_cylinder` de las garrafas, por id, `FOR UPDATE` (la rendición puede
   *     mover el vendible; no se sube de modo después);
   *  2. el depósito de destino, `FOR SHARE`;
   *  3. las filas de saldo del depósito y del camión, ordenadas por
   *     (ubicación, tipo, condición), `FOR UPDATE`.
   * Así una entrega en curso o ya asentada se ve completa antes de calcular, y
   * la operación del ledger que sigue no espera nada nuevo.
   */
  async bloquearParaRendicion(
    manager: EntityManager,
    args: {
      distributorId: string;
      gasCylinderIds: string[];
      depositLocationId: string;
      truckLocationId: string;
    },
  ): Promise<Map<string, number>> {
    const ids = [...new Set(args.gasCylinderIds)].sort((a, b) =>
      a.localeCompare(b),
    );
    if (ids.length === 0) return new Map();
    await manager.query(
      `SELECT 1 FROM "gas_cylinder"
       WHERE "gas_cylinder_id" = ANY($1::uuid[]) AND "distributor_id" = $2
       ORDER BY "gas_cylinder_id" FOR UPDATE`,
      [ids, args.distributorId],
    );
    await manager.query(
      `SELECT 1 FROM "warehouse" w
       JOIN "stock_location" l ON l."warehouse_id" = w."warehouse_id"
       WHERE l."location_id" = $1 AND w."deletedAt" IS NULL FOR SHARE OF w`,
      [args.depositLocationId],
    );
    await manager.query(
      `INSERT INTO "stock_balance" ("distributor_id", "location_id", "gas_cylinder_id", "condition", "quantity")
       SELECT $1, $2, g, c::"stock_condition_enum", 0
       FROM unnest($3::uuid[]) AS g, unnest($4::text[]) AS c
       ON CONFLICT ("location_id", "gas_cylinder_id", "condition") DO NOTHING`,
      [
        args.distributorId,
        args.depositLocationId,
        ids,
        [StockCondition.FULL, StockCondition.EMPTY],
      ],
    );
    const filas: Array<{
      location_id: string;
      gas_cylinder_id: string;
      condition: StockCondition;
      quantity: number;
    }> = await manager.query(
      `SELECT "location_id", "gas_cylinder_id", "condition", "quantity"
       FROM "stock_balance"
       WHERE "location_id" = ANY($1::uuid[]) AND "gas_cylinder_id" = ANY($2::uuid[])
         AND "condition" IN ('full', 'empty', 'defective')
       ORDER BY "location_id", "gas_cylinder_id", "condition"
       FOR UPDATE`,
      [[args.depositLocationId, args.truckLocationId], ids],
    );
    return new Map(
      filas.map((f) => [
        claveDeSaldo(f.location_id, f.gas_cylinder_id, f.condition),
        f.quantity,
      ]),
    );
  }
}
