import { MigrationInterface, QueryRunner } from 'typeorm';

const CLAVES = [
  'transferPercentage',
  'mercadoPagoPercentage',
  'cashPercentage',
];

const condicion = CLAVES.map(
  (k) =>
    `("params" -> '${k}' IS NULL OR (jsonb_typeof("params" -> '${k}') = 'number' AND ("params" ->> '${k}')::numeric BETWEEN 0 AND 30 AND ("params" ->> '${k}')::numeric = round(("params" ->> '${k}')::numeric, 2)))`,
).join(' AND ');

/**
 * Recargo por medio de pago configurable: el proceso `payment_surcharges` de
 * `module_config` (con su CHECK: 0 a 30 %, hasta 2 decimales) y, en el pedido,
 * el porcentaje con que se calculó el recargo. Los pedidos existentes quedan
 * con el porcentaje en `NULL` (regía 10 % online y 0 % en efectivo): ningún
 * monto cambia.
 */
export class RecargoPorMedioDePagoConfigurable1794700000004
  implements MigrationInterface
{
  name = 'RecargoPorMedioDePagoConfigurable1794700000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // El CHECK compara como texto: un valor recién agregado al enum no se puede
    // usar como literal del tipo en la misma transacción.
    await queryRunner.query(
      `ALTER TYPE "public"."configurable_process_enum" ADD VALUE IF NOT EXISTS 'payment_surcharges'`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_recargos" CHECK ("module"::text <> 'payment_surcharges' OR (${condicion}))`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD "payment_surcharge_percentage" numeric(5,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD CONSTRAINT "CHK_order_recargo_porcentaje" CHECK ("payment_surcharge_percentage" IS NULL OR ("payment_surcharge_percentage" BETWEEN 0 AND 30 AND ("payment_surcharge_amount" = 0 OR "payment_surcharge_percentage" > 0)))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order" DROP CONSTRAINT "CHK_order_recargo_porcentaje"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" DROP COLUMN "payment_surcharge_percentage"`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_recargos"`,
    );
    // Postgres no quita un valor de un enum: `payment_surcharges` queda en el
    // tipo, sin filas.
    await queryRunner.query(
      `DELETE FROM "module_config" WHERE "module" = 'payment_surcharges'`,
    );
  }
}
