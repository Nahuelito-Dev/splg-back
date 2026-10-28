import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * API v2, seguros de los vehículos (F14), primera parte: los valores nuevos de
 * los enums. Va aparte de las tablas porque un valor de enum agregado no se
 * puede usar en la misma transacción que lo agrega (la categoría «Seguros» se
 * siembra en `Seguros`).
 *
 * - `cash_category.system_code` y `cash_movement.reference_type`: el pago de
 *   una cuota es un egreso de caja con su categoría de sistema y su origen.
 * - `attachment.owner_type`: la póliza y la cuota pasan a ser dueñas de adjuntos.
 */
export class SegurosEnumsDeCajaYAdjuntos1793600000000
  implements MigrationInterface
{
  name = 'SegurosEnumsDeCajaYAdjuntos1793600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."cash_category_system_code_enum" ADD VALUE IF NOT EXISTS 'insurance'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."cash_movement_reference_type_enum" ADD VALUE IF NOT EXISTS 'insurance_installment'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."attachment_owner_type_enum" ADD VALUE IF NOT EXISTS 'insurance_policy'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."attachment_owner_type_enum" ADD VALUE IF NOT EXISTS 'insurance_installment'`,
    );
  }

  /**
   * Aborta antes de tocar nada si hay movimientos o adjuntos con los valores
   * nuevos: esa historia no se descarta sola. Las categorías «Seguros» sin
   * movimientos sí se quitan, como las demás categorías de sistema.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const usos: unknown = await queryRunner.query(
      `SELECT
         (SELECT count(*) FROM "cash_movement" WHERE "reference_type" = 'insurance_installment') AS movimientos,
         (SELECT count(*) FROM "cash_movement" m JOIN "cash_category" c ON c."category_id" = m."category_id" WHERE c."system_code" = 'insurance') AS en_categoria,
         (SELECT count(*) FROM "attachment" WHERE "owner_type" IN ('insurance_policy', 'insurance_installment')) AS adjuntos`,
    );
    const { movimientos, en_categoria, adjuntos } = (
      usos as Array<{
        movimientos: string;
        en_categoria: string;
        adjuntos: string;
      }>
    )[0];
    if (
      Number(movimientos) > 0 ||
      Number(en_categoria) > 0 ||
      Number(adjuntos) > 0
    ) {
      throw new Error(
        `No se puede revertir: hay ${movimientos} movimientos de caja de cuotas de seguro, ${en_categoria} en la categoría «Seguros» y ${adjuntos} adjuntos de pólizas o cuotas`,
      );
    }
    await queryRunner.query(
      `DELETE FROM "cash_category" WHERE "system_code" = 'insurance'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."cash_category_system_code_enum" RENAME TO "cash_category_system_code_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."cash_category_system_code_enum" AS ENUM('driver_settlement', 'customer_payment', 'commission_payment', 'cash_surplus', 'cash_shortage', 'transfer_in', 'transfer_out', 'purchase', 'fuel', 'traffic_fine', 'order_payment')`,
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
      `CREATE TYPE "public"."cash_movement_reference_type_enum" AS ENUM('manual', 'session_opening', 'session_closing', 'driver_settlement', 'customer_payment', 'purchase_receipt', 'fuel_load', 'traffic_fine', 'driver_liquidation', 'box_transfer', 'reversal', 'order_payment')`,
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
    await queryRunner.query(
      `ALTER TYPE "public"."attachment_owner_type_enum" RENAME TO "attachment_owner_type_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."attachment_owner_type_enum" AS ENUM('employee', 'fuel_load', 'traffic_fine', 'vehicle_accident', 'purchase_receipt', 'stock_adjustment', 'driver_settlement', 'cash_movement', 'customer_account_entry', 'order')`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" ALTER COLUMN "owner_type" TYPE "public"."attachment_owner_type_enum" USING "owner_type"::text::"public"."attachment_owner_type_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."attachment_owner_type_enum_old"`,
    );
  }
}
