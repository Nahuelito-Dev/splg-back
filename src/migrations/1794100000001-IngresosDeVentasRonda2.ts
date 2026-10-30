import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Caja completa, etapa 3, ronda 2.
 * - `cash_movement.created_by_user_id` admite null sólo en los orígenes que se
 *   asientan solos (CHECK que lo exige en el resto).
 * - El índice único de cobros de ventas suma `order_deposit`.
 * - `order.deposit_paid_at`: cuándo se confirmó la seña a mano.
 */
export class IngresosDeVentasRonda21794100000001 implements MigrationInterface {
  name = 'IngresosDeVentasRonda21794100000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const sql = (texto: string) => queryRunner.query(texto);
    await sql(
      `ALTER TABLE "cash_movement" ALTER COLUMN "created_by_user_id" DROP NOT NULL`,
    );
    await sql(
      `ALTER TABLE "cash_movement" ADD CONSTRAINT "CHK_cash_movement_autor" CHECK ("created_by_user_id" IS NOT NULL OR "reference_type" IN ('payment', 'payment_fee', 'payment_refund', 'payment_external_refund'))`,
    );
    await sql(`DROP INDEX "UQ_cash_movement_cobro_de_venta"`);
    await sql(
      `CREATE UNIQUE INDEX "UQ_cash_movement_cobro_de_venta" ON "cash_movement" ("reference_type", "reference_id") WHERE "reference_type" IN ('payment', 'payment_fee', 'payment_refund', 'order_transfer', 'order_deposit')`,
    );
    await sql(
      `ALTER TABLE "order" ADD "deposit_paid_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  /** Aborta si hay movimientos sin autor o señas asentadas: esa historia no se descarta sola. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const filas: unknown = await queryRunner.query(
      `SELECT count(*) AS n FROM "cash_movement" WHERE "created_by_user_id" IS NULL OR "reference_type" = 'order_deposit'`,
    );
    const { n } = (filas as Array<{ n: string }>)[0];
    if (Number(n) > 0) {
      throw new Error(
        `No se puede revertir: hay ${n} movimientos de caja sin autor o de señas`,
      );
    }
    const sql = (texto: string) => queryRunner.query(texto);
    await sql(`ALTER TABLE "order" DROP COLUMN "deposit_paid_at"`);
    await sql(`DROP INDEX "UQ_cash_movement_cobro_de_venta"`);
    await sql(
      `CREATE UNIQUE INDEX "UQ_cash_movement_cobro_de_venta" ON "cash_movement" ("reference_type", "reference_id") WHERE "reference_type" IN ('payment', 'payment_fee', 'payment_refund', 'order_transfer')`,
    );
    await sql(
      `ALTER TABLE "cash_movement" DROP CONSTRAINT "CHK_cash_movement_autor"`,
    );
    await sql(
      `ALTER TABLE "cash_movement" ALTER COLUMN "created_by_user_id" SET NOT NULL`,
    );
  }
}
