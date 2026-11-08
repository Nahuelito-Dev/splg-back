import { MigrationInterface, QueryRunner } from 'typeorm';

export class FormulaDelTotalConEnvases1795000000016
  implements MigrationInterface
{
  name = 'FormulaDelTotalConEnvases1795000000016';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order" DROP CONSTRAINT "CHK_order_total_formula"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD CONSTRAINT "CHK_order_total_formula" CHECK ("totalAmount" = "subtotal_items" + "zone_surcharge_amount" + "container_charge_amount" + "payment_surcharge_amount" + CASE WHEN "express_degraded_at" IS NULL THEN "express_surcharge_amount" ELSE 0 END) NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" VALIDATE CONSTRAINT "CHK_order_total_formula"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_customer_container_movement_compra" ON "customer_container_movement" ("account_id", "order_id") WHERE "reason" = 'purchased'`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."UQ_customer_container_movement_compra"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" DROP CONSTRAINT "CHK_order_total_formula"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD CONSTRAINT "CHK_order_total_formula" CHECK ("totalAmount" = "subtotal_items" + "zone_surcharge_amount" + "payment_surcharge_amount" + CASE WHEN "express_degraded_at" IS NULL THEN "express_surcharge_amount" ELSE 0 END) NOT VALID`,
    );
    // Sin VALIDATE: los pedidos con envases cobrados no cumplen la fórmula vieja; queda NOT VALID
    // (rige para los pedidos nuevos) y el revert no aborta.
  }
}
