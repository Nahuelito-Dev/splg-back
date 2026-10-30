import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F15, comprobante de la multa con dueño propio, primera parte: el valor nuevo de
 * `attachment.owner_type`. Va aparte de `ComprobanteDeMultaDuenoPropio` porque un
 * valor de enum agregado no se puede usar en la misma transacción que lo agrega.
 */
export class ComprobanteDeMultaDuenoPropioEnum1793800000002
  implements MigrationInterface
{
  name = 'ComprobanteDeMultaDuenoPropioEnum1793800000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."attachment_owner_type_enum" ADD VALUE IF NOT EXISTS 'traffic_fine_payment'`,
    );
  }

  /** Aborta si hay adjuntos con el valor nuevo: esa historia no se descarta sola. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const filas: unknown = await queryRunner.query(
      `SELECT count(*) AS n FROM "attachment" WHERE "owner_type" = 'traffic_fine_payment'`,
    );
    const usos = filas as Array<{ n: string }>;
    if (Number(usos[0]?.n ?? 0) > 0) {
      throw new Error(
        `No se puede revertir: hay ${usos[0].n} comprobantes de multas; devolvelos antes con ComprobanteDeMultaDuenoPropio.down`,
      );
    }
    await queryRunner.query(
      `ALTER TYPE "public"."attachment_owner_type_enum" RENAME TO "attachment_owner_type_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."attachment_owner_type_enum" AS ENUM('employee', 'fuel_load', 'traffic_fine', 'vehicle_accident', 'purchase_receipt', 'stock_adjustment', 'driver_settlement', 'cash_movement', 'customer_account_entry', 'order', 'insurance_policy', 'insurance_installment')`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" ALTER COLUMN "owner_type" TYPE "public"."attachment_owner_type_enum" USING "owner_type"::text::"public"."attachment_owner_type_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."attachment_owner_type_enum_old"`,
    );
  }
}
