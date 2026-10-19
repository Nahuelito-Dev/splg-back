import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * El efectivo que la distribuidora paga por una multa o por el combustible sale
 * de una caja por el libro: la multa y la carga guardan la salida
 * (`cash_movement_id`, sin clave foránea, igual que `purchase_receipt`). Las
 * categorías de sistema `purchase`, `fuel` y `traffic_fine` y los orígenes
 * `purchase_receipt`, `fuel_load` y `traffic_fine` ya existían. La carga marca además quién la
 * registró (`registered_by_driver`) y si es una `cash_box` anterior (`cash_payment_legacy`: no se asienta).
 */
export class EgresosDeEfectivoACaja1792600000000 implements MigrationInterface {
  name = 'EgresosDeEfectivoACaja1792600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "traffic_fine" ADD "cash_movement_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "fuel_load" ADD "cash_movement_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "fuel_load" ADD "registered_by_driver" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "fuel_load" ADD "cash_payment_legacy" boolean NOT NULL DEFAULT false`,
    );
    // Las cargas `cash_box` anteriores no tienen asiento ni se pueden asentar
    // después: ya se resolvieron fuera del libro (rendición o ajuste manual).
    await queryRunner.query(
      `UPDATE "fuel_load" SET "cash_payment_legacy" = true WHERE "payment_method" = 'cash_box'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "fuel_load" DROP COLUMN "cash_payment_legacy"`,
    );
    await queryRunner.query(
      `ALTER TABLE "fuel_load" DROP COLUMN "registered_by_driver"`,
    );
    await queryRunner.query(
      `ALTER TABLE "fuel_load" DROP COLUMN "cash_movement_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "traffic_fine" DROP COLUMN "cash_movement_id"`,
    );
  }
}
