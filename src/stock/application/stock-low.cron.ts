import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { errorMessage } from '../../common/errors/error-message';
import { ZONA_ARGENTINA } from '../../common/utils/dias-argentina';
import {
  escaparHtml,
  StockAdminNotifier,
} from './stock-admin-notifier.service';

interface FilaDeUmbral {
  threshold_id: string;
  distributor_id: string;
  warehouse_name: string;
  type: string;
  min_full: number;
  current_full: number;
  alerted_at: Date | null;
}

/**
 * Aviso diario de stock bajo: depósitos cuyas llenas de un tipo quedaron por
 * debajo del mínimo configurado. Se avisa UNA vez (`alerted_at`) y el aviso
 * se limpia cuando el depósito se recupera, así vuelve a avisar si baja otra
 * vez. Si el envío falla no se marca: se reintenta mañana.
 */
@Injectable()
export class StockLowCron {
  private readonly logger = new Logger(StockLowCron.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly notifier: StockAdminNotifier,
  ) {}

  @Cron('0 8 * * *', { timeZone: ZONA_ARGENTINA })
  async avisarStockBajo(): Promise<void> {
    const filas: FilaDeUmbral[] = await this.dataSource.query(
      `SELECT t."threshold_id", t."distributor_id", w."name" AS warehouse_name, gc."type",
              t."min_full", t."alerted_at", COALESCE(b."quantity", 0) AS current_full
       FROM "stock_threshold" t
       JOIN "warehouse" w ON w."warehouse_id" = t."warehouse_id" AND w."deletedAt" IS NULL
       JOIN "gas_cylinder" gc ON gc."gas_cylinder_id" = t."gas_cylinder_id"
       JOIN "stock_location" l ON l."warehouse_id" = w."warehouse_id"
       LEFT JOIN "stock_balance" b ON b."location_id" = l."location_id"
         AND b."gas_cylinder_id" = t."gas_cylinder_id" AND b."condition" = 'full'`,
    );

    const recuperados: string[] = [];
    const nuevos = new Map<string, FilaDeUmbral[]>();
    for (const f of filas) {
      const bajo = f.min_full > 0 && f.current_full < f.min_full;
      if (!bajo && f.alerted_at) recuperados.push(f.threshold_id);
      if (bajo && !f.alerted_at) {
        const lista = nuevos.get(f.distributor_id) ?? [];
        lista.push(f);
        nuevos.set(f.distributor_id, lista);
      }
    }

    if (recuperados.length > 0) {
      await this.dataSource.query(
        `UPDATE "stock_threshold" SET "alerted_at" = NULL
         WHERE "threshold_id" = ANY($1::uuid[])`,
        [recuperados],
      );
    }
    for (const [distributorId, umbrales] of nuevos) {
      await this.avisarDistribuidora(distributorId, umbrales);
    }
  }

  private async avisarDistribuidora(
    distributorId: string,
    umbrales: FilaDeUmbral[],
  ): Promise<void> {
    try {
      const items = umbrales
        .map(
          (u) =>
            `<li>${escaparHtml(u.warehouse_name)}: ${escaparHtml(u.type)} — ${u.current_full} llenas (mínimo ${u.min_full})</li>`,
        )
        .join('');
      await this.notifier.avisar(
        distributorId,
        `Stock bajo: ${umbrales.length} garrafa(s) por debajo del mínimo`,
        `<p>Estos depósitos quedaron por debajo del mínimo de garrafas llenas:</p><ul>${items}</ul>`,
      );
      // Sin administradores con email no hay a quién avisarle dos veces: se
      // marca igual, como en el aviso de flota.
      await this.dataSource.query(
        `UPDATE "stock_threshold" SET "alerted_at" = now()
         WHERE "threshold_id" = ANY($1::uuid[])`,
        [umbrales.map((u) => u.threshold_id)],
      );
    } catch (error) {
      this.logger.error(
        `No se pudo avisar el stock bajo de la distribuidora ${distributorId}: ${errorMessage(error)}`,
      );
    }
  }
}
