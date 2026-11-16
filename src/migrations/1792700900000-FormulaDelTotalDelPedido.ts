import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * El total del pedido es la suma exacta de sus partes: ítems + zona + recargo
 * por medio de pago + express (el express ya no cuenta si el pedido pasó al
 * reparto común). Va en una migración aparte y al final porque exige que todo
 * el back que crea o edita pedidos complete `payment_surcharge_amount`: antes de
 * validar, se completa en los pedidos creados mientras tanto con la diferencia.
 */
export class FormulaDelTotalDelPedido1792700900000
  implements MigrationInterface
{
  name = 'FormulaDelTotalDelPedido1792700900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "order"
          SET "payment_surcharge_amount" = "totalAmount"
              - "subtotal_items" - "zone_surcharge_amount"
              - CASE WHEN "express_degraded_at" IS NULL
                     THEN "express_surcharge_amount" ELSE 0 END
        WHERE "totalAmount" <> "subtotal_items" + "zone_surcharge_amount"
              + "payment_surcharge_amount"
              + CASE WHEN "express_degraded_at" IS NULL
                     THEN "express_surcharge_amount" ELSE 0 END`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD CONSTRAINT "CHK_order_total_formula" CHECK ("totalAmount" = "subtotal_items" + "zone_surcharge_amount" + "payment_surcharge_amount" + CASE WHEN "express_degraded_at" IS NULL THEN "express_surcharge_amount" ELSE 0 END) NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" VALIDATE CONSTRAINT "CHK_order_total_formula"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order" DROP CONSTRAINT "CHK_order_total_formula"`,
    );
  }
}
