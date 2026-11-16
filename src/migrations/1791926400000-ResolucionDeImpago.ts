import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Quién y cuándo resolvió un admin un impago (cobrado o pérdida), separado de
 * `payment_confirmed_*`, que queda sólo para los cobros. Además cierra las
 * incidencias de cobro impago abiertas cuyo pedido ya se resolvió (el panel
 * las cerraba con una segunda llamada que podía no hacerse). Aditiva e
 * idempotente.
 */
export class ResolucionDeImpago1791926400000 implements MigrationInterface {
  name = 'ResolucionDeImpago1791926400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order" ADD "payment_resolved_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD "payment_resolved_by" uuid`,
    );
    // Lo ya resuelto: quien lo resolvió es quien quedó en payment_confirmed_*;
    // una pérdida no es un cobro, así que ahí se vacían. (`::text`: el valor
    // `written_off` lo agregó otra migración en esta misma transacción y Postgres
    // no deja usarlo como enum hasta el commit.)
    await queryRunner.query(
      `UPDATE "order" SET "payment_resolved_at" = "payment_confirmed_at", "payment_resolved_by" = "payment_confirmed_by" WHERE "payment_resolution_note" IS NOT NULL`,
    );
    await queryRunner.query(
      `UPDATE "order" SET "payment_confirmed_at" = NULL, "payment_confirmed_by" = NULL WHERE "paymentStatus"::text = 'written_off'`,
    );
    await queryRunner.query(
      `UPDATE "incident" i SET "status" = 'resolved', "resolution_note" = COALESCE(o."payment_resolution_note", 'Cobro regularizado: el pedido ya figuraba como ' || o."paymentStatus"::text), "resolvedAt" = COALESCE(o."payment_resolved_at", o."payment_confirmed_at", now()) FROM "order" o WHERE o."order_id" = i."order_id" AND i."type" = 'unpaid_collection' AND i."status" = 'open' AND o."paymentStatus"::text IN ('paid', 'written_off')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order" DROP COLUMN "payment_resolved_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" DROP COLUMN "payment_resolved_at"`,
    );
  }
}
