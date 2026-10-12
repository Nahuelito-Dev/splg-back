import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ajustes de compras: cierre con faltante de una orden, snapshot del costo
 * promedio por renglón de recepción (para deshacerlo al anular) y el
 * documento del proveedor único por tipo (remito y factura numeran aparte).
 * Sólo agrega columnas y un valor de enum; reemplaza un índice único.
 */
export class ComprasAjustes1791754757678 implements MigrationInterface {
  name = 'ComprasAjustes1791754757678';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."purchase_order_status_enum" ADD VALUE IF NOT EXISTS 'closed_short' BEFORE 'cancelled'`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order" ADD "close_reason" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_receipt_item" ADD "previous_average_cost" numeric(12,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_receipt_item" ADD "previous_on_hand" integer`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_purchase_receipt_documento_proveedor"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_purchase_receipt_documento_proveedor" ON "purchase_receipt" ("distributor_id", "supplier_id", "supplier_document_type", "supplier_document_number") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."UQ_purchase_receipt_documento_proveedor"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_purchase_receipt_documento_proveedor" ON "purchase_receipt" ("distributor_id", "supplier_id", "supplier_document_number") `,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_receipt_item" DROP COLUMN "previous_on_hand"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_receipt_item" DROP COLUMN "previous_average_cost"`,
    );
    await queryRunner.query(
      `UPDATE "purchase_order" SET "status" = 'partially_received' WHERE "status" = 'closed_short'`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order" DROP COLUMN "close_reason"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_purchase_order_estado"`);
    await queryRunner.query(
      `CREATE TYPE "public"."purchase_order_status_enum_old" AS ENUM('draft', 'sent', 'partially_received', 'received', 'cancelled')`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order" ALTER COLUMN "status" TYPE "public"."purchase_order_status_enum_old" USING "status"::"text"::"public"."purchase_order_status_enum_old"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order" ALTER COLUMN "status" SET DEFAULT 'draft'`,
    );
    await queryRunner.query(`DROP TYPE "public"."purchase_order_status_enum"`);
    await queryRunner.query(
      `ALTER TYPE "public"."purchase_order_status_enum_old" RENAME TO "purchase_order_status_enum"`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_purchase_order_estado" ON "purchase_order" ("distributor_id", "status") `,
    );
  }
}
