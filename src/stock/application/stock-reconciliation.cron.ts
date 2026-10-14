import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { errorMessage } from '../../common/errors/error-message';
import { RedisService } from '../../redis/redis.service';
import { ZONA_ARGENTINA } from '../../common/utils/dias-argentina';
import {
  escaparHtml,
  StockAdminNotifier,
} from './stock-admin-notifier.service';
import { StockReconciliationService } from './stock-reconciliation.service';

/**
 * Conciliación nocturna del vendible contra el físico (D4). Avisa por email a
 * los administradores si hay diferencias; NO corrige nada: una cifra que no
 * cierra es algo que una persona tiene que mirar.
 */
@Injectable()
export class StockReconciliationCron {
  private readonly logger = new Logger(StockReconciliationCron.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly reconciliation: StockReconciliationService,
    private readonly notifier: StockAdminNotifier,
    private readonly redis: RedisService,
  ) {}

  @Cron('0 3 * * *', { timeZone: ZONA_ARGENTINA })
  async conciliarTodas(): Promise<void> {
    // Con varias instancias corre sólo una: si no, el mail sale duplicado.
    const lock = await this.redis.withLock(
      'cron:stock-reconciliation',
      5 * 60_000,
      () => this.conciliarDistribuidoras(),
    );
    if (!lock.obtenido) {
      this.logger.log(
        'Conciliación de stock: la está corriendo otra instancia',
      );
    }
  }

  private async conciliarDistribuidoras(): Promise<void> {
    const distribuidoras: Array<{ distributor_id: string }> =
      await this.dataSource.query(
        `SELECT DISTINCT w."distributor_id" FROM "warehouse" w
         JOIN "distributor" d ON d."distributor_id" = w."distributor_id" AND d."deletedAt" IS NULL
         WHERE w."deletedAt" IS NULL`,
      );
    for (const { distributor_id } of distribuidoras) {
      await this.conciliar(distributor_id);
    }
  }

  async conciliar(distributorId: string): Promise<void> {
    try {
      const resultado = await this.reconciliation.conciliar(distributorId);
      if (resultado.consistent) {
        // Volvió a cerrar: el próximo desvío tiene que avisar de nuevo.
        await this.dataSource.query(
          `DELETE FROM "stock_reconciliation_alert" WHERE "distributor_id" = $1`,
          [distributorId],
        );
        return;
      }
      const firma = firmaDe(resultado);
      const [previo]: Array<{ signature: string }> =
        await this.dataSource.query(
          `SELECT "signature" FROM "stock_reconciliation_alert" WHERE "distributor_id" = $1`,
          [distributorId],
        );
      // La misma diferencia de anoche no se vuelve a avisar.
      if (previo?.signature === firma) return;
      const diferencias = resultado.cylinders
        .filter(conProblema)
        .map(
          (c) =>
            `<li>${escaparHtml(c.gasCylinderType)}: vendible ${c.sellable}, esperado ${c.expected} (llenas ${c.physicalFull} − reservadas ${c.reserved}); diferencia ${c.difference}` +
            (c.overReserved > 0
              ? `; ${c.overReserved} reservada(s) de más que el físico no cubre: hay que cancelar pedidos o reponer stock`
              : '') +
            '</li>',
        )
        .join('');
      const sinMovimiento = resultado.deliveriesWithoutMovement.length;
      this.logger.warn(
        `Conciliación de stock de ${distributorId}: ${resultado.cylinders.filter(conProblema).length} garrafa(s) con diferencia y ${sinMovimiento} renglón(es) entregado(s) sin movimiento`,
      );
      await this.notifier.avisar(
        distributorId,
        'Conciliación de stock: hay diferencias',
        `<p>El stock vendible no coincide con el físico:</p><ul>${diferencias}</ul>` +
          (sinMovimiento > 0
            ? `<p>${sinMovimiento} renglón(es) de pedidos entregados no descontaron el stock físico.</p>`
            : ''),
      );
      await this.dataSource.query(
        `INSERT INTO "stock_reconciliation_alert" ("distributor_id", "signature")
         VALUES ($1, $2)
         ON CONFLICT ("distributor_id") DO UPDATE
         SET "signature" = EXCLUDED."signature", "alerted_at" = now()`,
        [distributorId, firma],
      );
    } catch (error) {
      this.logger.error(
        `No se pudo conciliar el stock de la distribuidora ${distributorId}: ${errorMessage(error)}`,
      );
    }
  }
}

/** ¿La garrafa tiene algo que avisar? Vendible desfasado, reservas de más o déficit desfasado. */
const conProblema = (c: {
  difference: number;
  overReserved: number;
  deficitDifference?: number;
}): boolean =>
  c.difference !== 0 || c.overReserved > 0 || (c.deficitDifference ?? 0) !== 0;

/** Huella de las diferencias: cambia si cambia una cifra o una entrega pendiente. */
function firmaDe(r: {
  cylinders: Array<{
    gasCylinderId: string;
    difference: number;
    overReserved: number;
    deficitDifference?: number;
  }>;
  deliveriesWithoutMovement: Array<{ orderId: string; gasCylinderId: string }>;
}): string {
  const partes = [
    ...r.cylinders
      .filter(conProblema)
      .map(
        (c) =>
          `c:${c.gasCylinderId}:${c.difference}:${c.overReserved}:${c.deficitDifference ?? 0}`,
      ),
    ...r.deliveriesWithoutMovement.map(
      (e) => `e:${e.orderId}:${e.gasCylinderId}`,
    ),
  ].sort();
  return createHash('sha256').update(partes.join('|')).digest('hex');
}
