import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * El efectivo se cobra cuando el chofer lo confirma, no al entregar: el pago
 * puede quedar impago (o perdido) y hay que saber quién y cuándo lo confirmó.
 */
export class CobroEnEfectivoConfirmado1791840000000
  implements MigrationInterface
{
  name = 'CobroEnEfectivoConfirmado1791840000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."order_paymentstatus_enum" ADD VALUE IF NOT EXISTS 'unpaid'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."order_paymentstatus_enum" ADD VALUE IF NOT EXISTS 'written_off'`,
    );
    // El enum del tipo se recrea (no ADD VALUE): el índice único de abajo usa
    // el valor nuevo, y Postgres no deja usarlo en la misma transacción.
    await queryRunner.query(
      `ALTER TYPE "public"."incident_type_enum" RENAME TO "incident_type_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."incident_type_enum" AS ENUM('damaged', 'out_of_stock', 'no_show', 'unpaid_collection', 'other')`,
    );
    await queryRunner.query(
      `ALTER TABLE "incident" ALTER COLUMN "type" TYPE "public"."incident_type_enum" USING "type"::text::"public"."incident_type_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."incident_type_enum_old"`);
    await queryRunner.query(
      `ALTER TABLE "order" ADD "payment_confirmed_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD "payment_confirmed_by" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD "payment_resolution_note" text`,
    );
    // Una sola incidencia de cobro impago viva por pedido, aunque lleguen
    // varios avisos a la vez.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_incident_cobro_impago" ON "incident" ("order_id") WHERE "type" = 'unpaid_collection' AND "status" IN ('open', 'resolved')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_incident_cobro_impago"`);
    await queryRunner.query(
      `ALTER TABLE "order" DROP COLUMN "payment_resolution_note"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" DROP COLUMN "payment_confirmed_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" DROP COLUMN "payment_confirmed_at"`,
    );
    // Los valores nuevos de los enums quedan sin uso: Postgres no los quita.
  }
}
