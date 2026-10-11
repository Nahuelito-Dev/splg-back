import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { UpsertThresholdsDto } from '../dto/stock-threshold.dto';
import { StockThresholdDto } from '../dto/stock-response.dto';

@Injectable()
export class StockThresholdService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async listar(distributorId: string): Promise<StockThresholdDto[]> {
    const filas: Array<{
      threshold_id: string;
      warehouse_id: string;
      warehouse_name: string;
      gas_cylinder_id: string;
      type: string;
      min_full: number;
      current_full: number;
      alerted_at: Date | null;
    }> = await this.dataSource.query(
      `SELECT t."threshold_id", t."warehouse_id", w."name" AS warehouse_name,
              t."gas_cylinder_id", gc."type", t."min_full", t."alerted_at",
              COALESCE(b."quantity", 0) AS current_full
       FROM "stock_threshold" t
       JOIN "warehouse" w ON w."warehouse_id" = t."warehouse_id" AND w."deletedAt" IS NULL
       JOIN "gas_cylinder" gc ON gc."gas_cylinder_id" = t."gas_cylinder_id"
       JOIN "stock_location" l ON l."warehouse_id" = w."warehouse_id"
       LEFT JOIN "stock_balance" b ON b."location_id" = l."location_id"
         AND b."gas_cylinder_id" = t."gas_cylinder_id" AND b."condition" = 'full'
       WHERE t."distributor_id" = $1
       ORDER BY w."name", gc."type"`,
      [distributorId],
    );
    return filas.map((f) => ({
      thresholdId: f.threshold_id,
      warehouseId: f.warehouse_id,
      warehouseName: f.warehouse_name,
      gasCylinderId: f.gas_cylinder_id,
      gasCylinderType: f.type,
      minFull: f.min_full,
      currentFull: f.current_full,
      alertedAt: f.alerted_at,
    }));
  }

  /**
   * Alta o cambio de varios mínimos de una vez. Un mínimo que cambia borra el
   * aviso vigente (`alerted_at`): se vuelve a evaluar con el valor nuevo.
   */
  async upsert(
    dto: UpsertThresholdsDto,
    distributorId: string,
  ): Promise<StockThresholdDto[]> {
    const pares = new Map(
      dto.thresholds.map((t) => [`${t.warehouseId}|${t.gasCylinderId}`, t]),
    );
    const items = [...pares.values()];
    await this.dataSource.transaction(async (manager) => {
      const depositos = [...new Set(items.map((i) => i.warehouseId))];
      const vigentes: Array<{ warehouse_id: string }> = await manager.query(
        `SELECT "warehouse_id" FROM "warehouse"
         WHERE "warehouse_id" = ANY($1::uuid[]) AND "distributor_id" = $2 AND "deletedAt" IS NULL`,
        [depositos, distributorId],
      );
      const faltaDeposito = depositos.find(
        (id) => !vigentes.some((v) => v.warehouse_id === id),
      );
      if (faltaDeposito) {
        throw new NotFoundException(`Depósito ${faltaDeposito} no encontrado`);
      }
      const garrafas = [...new Set(items.map((i) => i.gasCylinderId))];
      const existentes: Array<{ gas_cylinder_id: string }> =
        await manager.query(
          `SELECT "gas_cylinder_id" FROM "gas_cylinder"
           WHERE "gas_cylinder_id" = ANY($1::uuid[]) AND "distributor_id" = $2`,
          [garrafas, distributorId],
        );
      const faltaGarrafa = garrafas.find(
        (id) => !existentes.some((e) => e.gas_cylinder_id === id),
      );
      if (faltaGarrafa) {
        throw new NotFoundException(`Garrafa ${faltaGarrafa} no encontrada`);
      }
      await manager.query(
        `INSERT INTO "stock_threshold" ("distributor_id", "warehouse_id", "gas_cylinder_id", "min_full")
         SELECT $1, k.w, k.g, k.m
         FROM unnest($2::uuid[], $3::uuid[], $4::int[]) AS k(w, g, m)
         ON CONFLICT ("warehouse_id", "gas_cylinder_id") DO UPDATE
         SET "min_full" = EXCLUDED."min_full",
             "alerted_at" = CASE WHEN "stock_threshold"."min_full" <> EXCLUDED."min_full"
                                 THEN NULL ELSE "stock_threshold"."alerted_at" END,
             "updatedAt" = now()`,
        [
          distributorId,
          items.map((i) => i.warehouseId),
          items.map((i) => i.gasCylinderId),
          items.map((i) => i.minFull),
        ],
      );
    });
    return this.listar(distributorId);
  }
}
