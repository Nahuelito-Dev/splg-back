import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * El cobro en efectivo que registra el administrador sobre un pedido entra a
 * una caja por el libro: nueva categoría de sistema y nuevo origen de
 * movimiento `order_payment`. Las categorías de las distribuidoras existentes
 * se siembran al usarse (`CashCategoryService.deSistema`).
 */
export class CobroDePedidoACaja1792500000000 implements MigrationInterface {
  name = 'CobroDePedidoACaja1792500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."cash_category_system_code_enum" ADD VALUE IF NOT EXISTS 'order_payment'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."cash_movement_reference_type_enum" ADD VALUE IF NOT EXISTS 'order_payment'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const filas: unknown = await queryRunner.query(
      `SELECT count(*) AS movimientos FROM "cash_movement" WHERE "reference_type" = 'order_payment'`,
    );
    const { movimientos } = (filas as Array<{ movimientos: string }>)[0];
    if (Number(movimientos) > 0) {
      throw new Error(
        'No se puede revertir: hay movimientos de caja con origen "order_payment"',
      );
    }
    await queryRunner.query(
      `DELETE FROM "cash_category" WHERE "system_code" = 'order_payment'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."cash_category_system_code_enum" RENAME TO "cash_category_system_code_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."cash_category_system_code_enum" AS ENUM('driver_settlement', 'customer_payment', 'commission_payment', 'cash_surplus', 'cash_shortage', 'transfer_in', 'transfer_out', 'purchase', 'fuel', 'traffic_fine')`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_category" ALTER COLUMN "system_code" TYPE "public"."cash_category_system_code_enum" USING "system_code"::text::"public"."cash_category_system_code_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."cash_category_system_code_enum_old"`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."cash_movement_reference_type_enum" RENAME TO "cash_movement_reference_type_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."cash_movement_reference_type_enum" AS ENUM('manual', 'session_opening', 'session_closing', 'driver_settlement', 'customer_payment', 'purchase_receipt', 'fuel_load', 'traffic_fine', 'driver_liquidation', 'box_transfer', 'reversal')`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_movement" ALTER COLUMN "reference_type" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_movement" ALTER COLUMN "reference_type" TYPE "public"."cash_movement_reference_type_enum" USING "reference_type"::text::"public"."cash_movement_reference_type_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_movement" ALTER COLUMN "reference_type" SET DEFAULT 'manual'`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."cash_movement_reference_type_enum_old"`,
    );
  }
}
