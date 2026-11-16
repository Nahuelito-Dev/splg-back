import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * El recargo por pagar online (+10 %) deja de estar escondido dentro del total:
 * se guarda en `payment_surcharge_amount`, así el total del pedido se puede
 * explicar (y controlar en la base) como ítems + zona + recargo online +
 * express. En los pedidos que ya existen se completa con lo que realmente se
 * cobró de más: total menos el resto de las partes (0 donde no se cobró
 * recargo). Un pedido que perdió el express (`express_degraded_at`) ya no lo
 * lleva en el total.
 */
export class RecargoPorMedioDePagoEnPedido1792700100000
  implements MigrationInterface
{
  name = 'RecargoPorMedioDePagoEnPedido1792700100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order" ADD "payment_surcharge_amount" numeric(10,2) NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `UPDATE "order"
          SET "payment_surcharge_amount" = "totalAmount"
              - "subtotal_items"
              - "zone_surcharge_amount"
              - CASE WHEN "express_degraded_at" IS NULL
                     THEN "express_surcharge_amount" ELSE 0 END`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order" DROP COLUMN "payment_surcharge_amount"`,
    );
  }
}
