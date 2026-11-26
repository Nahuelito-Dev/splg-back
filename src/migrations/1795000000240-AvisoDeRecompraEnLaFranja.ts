import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M3b: la invitación de recompra guarda desde cuándo se le puede avisar al
 * cliente (`notify_at`, el comienzo de su franja o la hora de la corrida) y
 * cuándo se le avisó (`notified_at`), más el ajuste por cliente que llevaba
 * (`offset_days`, M3a). Las invitaciones que ya existen se avisaron al crearse.
 */
export class AvisoDeRecompraEnLaFranja1795000000240
  implements MigrationInterface
{
  name = 'AvisoDeRecompraEnLaFranja1795000000240';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "repurchase_invitation" ADD "offset_days" integer NOT NULL DEFAULT '0'`,
    );
    await q.query(
      `ALTER TABLE "repurchase_invitation" ADD "notify_at" TIMESTAMP WITH TIME ZONE`,
    );
    await q.query(
      `ALTER TABLE "repurchase_invitation" ADD "notified_at" TIMESTAMP WITH TIME ZONE`,
    );
    await q.query(
      `UPDATE "repurchase_invitation" SET "notify_at" = "created_at", "notified_at" = "created_at"`,
    );
    await q.query(
      `CREATE INDEX "IDX_repurchase_invitation_por_avisar" ON "repurchase_invitation" ("notify_at") WHERE "status" = 'pending' AND "notified_at" IS NULL`,
    );
    await q.query(
      `ALTER TABLE "repurchase_invitation" ADD CONSTRAINT "CHK_repurchase_invitation_offset" CHECK ("offset_days" BETWEEN -15 AND 15)`,
    );
    await q.query(
      `ALTER TABLE "repurchase_invitation" ADD CONSTRAINT "CHK_repurchase_invitation_aviso" CHECK (("notify_at" IS NULL OR "notify_at" < "expires_at") AND ("notified_at" IS NULL OR "notify_at" IS NOT NULL))`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "repurchase_invitation" DROP CONSTRAINT "CHK_repurchase_invitation_aviso"`,
    );
    await q.query(
      `ALTER TABLE "repurchase_invitation" DROP CONSTRAINT "CHK_repurchase_invitation_offset"`,
    );
    await q.query(`DROP INDEX "public"."IDX_repurchase_invitation_por_avisar"`);
    await q.query(
      `ALTER TABLE "repurchase_invitation" DROP COLUMN "notified_at"`,
    );
    await q.query(
      `ALTER TABLE "repurchase_invitation" DROP COLUMN "notify_at"`,
    );
    await q.query(
      `ALTER TABLE "repurchase_invitation" DROP COLUMN "offset_days"`,
    );
  }
}
