import { MigrationInterface, QueryRunner } from 'typeorm';

const CBU_VALIDO = `"bank_cbu" IS NULL OR CASE WHEN "bank_cbu" ~ '^[0-9]{22}$' THEN (10 - ((substr("bank_cbu", 1, 1)::int * 7 + substr("bank_cbu", 2, 1)::int * 1 + substr("bank_cbu", 3, 1)::int * 3 + substr("bank_cbu", 4, 1)::int * 9 + substr("bank_cbu", 5, 1)::int * 7 + substr("bank_cbu", 6, 1)::int * 1 + substr("bank_cbu", 7, 1)::int * 3) % 10)) % 10 = substr("bank_cbu", 8, 1)::int AND (10 - ((substr("bank_cbu", 9, 1)::int * 3 + substr("bank_cbu", 10, 1)::int * 9 + substr("bank_cbu", 11, 1)::int * 7 + substr("bank_cbu", 12, 1)::int * 1 + substr("bank_cbu", 13, 1)::int * 3 + substr("bank_cbu", 14, 1)::int * 9 + substr("bank_cbu", 15, 1)::int * 7 + substr("bank_cbu", 16, 1)::int * 1 + substr("bank_cbu", 17, 1)::int * 3 + substr("bank_cbu", 18, 1)::int * 9 + substr("bank_cbu", 19, 1)::int * 7 + substr("bank_cbu", 20, 1)::int * 1 + substr("bank_cbu", 21, 1)::int * 3) % 10)) % 10 = substr("bank_cbu", 22, 1)::int ELSE false END`;

/**
 * API v2: adjuntos de pedidos y datos bancarios de la distribuidora.
 *
 * - `order` pasa a ser dueño de adjuntos (comprobante de la transferencia).
 * - La distribuidora guarda CBU, alias y titular para cobrar por transferencia,
 *   con las mismas reglas que el back (CBU de 22 dígitos con sus dos dígitos
 *   verificadores; alias de 6 a 20 caracteres: letras, números, punto y guion).
 */
export class ComprobanteDeTransferenciaYDatosBancarios1793149700000
  implements MigrationInterface
{
  name = 'ComprobanteDeTransferenciaYDatosBancarios1793149700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."attachment_owner_type_enum" ADD VALUE IF NOT EXISTS 'order'`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor" ADD "bank_cbu" character varying(22)`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor" ADD "bank_alias" character varying(20)`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor" ADD "bank_holder" character varying(120)`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor" ADD CONSTRAINT "CHK_distributor_cbu" CHECK (${CBU_VALIDO})`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor" ADD CONSTRAINT "CHK_distributor_alias" CHECK ("bank_alias" IS NULL OR "bank_alias" ~ '^[A-Za-z0-9.-]{6,20}$')`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor" ADD CONSTRAINT "CHK_distributor_titular" CHECK ("bank_holder" IS NULL OR char_length(btrim("bank_holder")) >= 2)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const filas: unknown = await queryRunner.query(
      `SELECT count(*) AS n FROM "attachment" WHERE "owner_type" = 'order'`,
    );
    if (Number((filas as Array<{ n: string }>)[0].n) > 0) {
      throw new Error(
        'No se puede revertir: hay adjuntos de pedidos (owner_type "order")',
      );
    }
    await queryRunner.query(
      `ALTER TABLE "distributor" DROP CONSTRAINT "CHK_distributor_titular"`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor" DROP CONSTRAINT "CHK_distributor_alias"`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor" DROP CONSTRAINT "CHK_distributor_cbu"`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor" DROP COLUMN "bank_holder"`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor" DROP COLUMN "bank_alias"`,
    );
    await queryRunner.query(`ALTER TABLE "distributor" DROP COLUMN "bank_cbu"`);
    await queryRunner.query(
      `ALTER TYPE "public"."attachment_owner_type_enum" RENAME TO "attachment_owner_type_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."attachment_owner_type_enum" AS ENUM('employee', 'fuel_load', 'traffic_fine', 'vehicle_accident', 'purchase_receipt', 'stock_adjustment', 'driver_settlement', 'cash_movement', 'customer_account_entry')`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" ALTER COLUMN "owner_type" TYPE "public"."attachment_owner_type_enum" USING "owner_type"::text::"public"."attachment_owner_type_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."attachment_owner_type_enum_old"`,
    );
  }
}
