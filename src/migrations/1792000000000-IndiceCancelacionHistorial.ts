import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Índice parcial para ubicar cuándo se canceló cada pedido (la última
 * transición a `cancelled` del historial), que usa `pendingRefund` de
 * `GET /reports/collections`. Aditiva e idempotente.
 */
export class IndiceCancelacionHistorial1792000000000
  implements MigrationInterface
{
  name = 'IndiceCancelacionHistorial1792000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_order_status_history_cancelacion" ON "order_status_history" ("order_id", "changed_at") WHERE "to_status" = 'cancelled'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_order_status_history_cancelacion"`,
    );
  }
}
