import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Caja completa, etapa 4 (API v2): conciliación con Mercado Pago. Usa los
 * valores de enum de `ConciliacionMpEnums`.
 *
 * - `mp_reconciliation`: una corrida (rango de hasta 31 días, estado, totales y
 *   el archivo del reporte en S3).
 * - `mp_reconciliation_item`: cada diferencia encontrada. Un índice único
 *   parcial impide que la misma fila del reporte (`row_key`) se aplique dos
 *   veces en una distribuidora, aunque dos corridas se pisen.
 * - Siembra las dos categorías de sistema nuevas en las distribuidoras existentes.
 */
export class ConciliacionMp1794200000001 implements MigrationInterface {
  name = 'ConciliacionMp1794200000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const sql = (texto: string) => queryRunner.query(texto);
    await sql(
      `CREATE TYPE "public"."mp_reconciliation_status_enum" AS ENUM('requested', 'ready', 'failed')`,
    );
    await sql(
      `CREATE TABLE "mp_reconciliation" ("reconciliation_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "requested_by_user_id" uuid NOT NULL, "from_date" date NOT NULL, "to_date" date NOT NULL, "status" "public"."mp_reconciliation_status_enum" NOT NULL DEFAULT 'requested', "include_account_level" boolean NOT NULL DEFAULT false, "mp_report_id" character varying(100), "file_name" character varying(255), "failure_reason" character varying(500), "summary" jsonb, "account_report_key" character varying(255), "report_attachment_id" uuid, "last_checked_at" TIMESTAMP WITH TIME ZONE, "ready_at" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_mp_reconciliation_id_distribuidora" UNIQUE ("reconciliation_id", "distributor_id"), CONSTRAINT "CHK_mp_reconciliation_estado" CHECK (("status" = 'ready' AND "ready_at" IS NOT NULL) OR ("status" = 'failed' AND "failure_reason" IS NOT NULL) OR "status" = 'requested'), CONSTRAINT "CHK_mp_reconciliation_rango" CHECK ("to_date" >= "from_date" AND "to_date" - "from_date" <= 30), CONSTRAINT "PK_387ef61f4db6b95c42485877f36" PRIMARY KEY ("reconciliation_id"))`,
    );
    await sql(
      `CREATE INDEX "IDX_mp_reconciliation_pendientes" ON "mp_reconciliation" ("status") WHERE "status" = 'requested'`,
    );
    await sql(
      `CREATE INDEX "IDX_mp_reconciliation_distribuidora" ON "mp_reconciliation" ("distributor_id", "createdAt")`,
    );
    await sql(
      `CREATE TYPE "public"."mp_reconciliation_item_kind_enum" AS ENUM('payment_not_in_cash', 'ledger_without_mp', 'amount_mismatch', 'fee_pending', 'fee_mismatch', 'tax_withholding', 'tax_row', 'refund_missing', 'fee_reimbursement', 'payout', 'unknown_payment', 'other_movement')`,
    );
    await sql(
      `CREATE TYPE "public"."mp_reconciliation_item_status_enum" AS ENUM('pending', 'applied')`,
    );
    await sql(
      `CREATE TABLE "mp_reconciliation_item" ("item_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "reconciliation_id" uuid NOT NULL, "distributor_id" uuid NOT NULL, "row_key" uuid NOT NULL, "kind" "public"."mp_reconciliation_item_kind_enum" NOT NULL, "account_level" boolean NOT NULL DEFAULT false, "source_id" character varying(100), "payment_id" uuid, "order_id" uuid, "occurred_at" TIMESTAMP WITH TIME ZONE, "mp_description" character varying(120) NOT NULL, "mp_amount" numeric(14,2), "ledger_amount" numeric(14,2), "difference" numeric(14,2), "extra_amount" numeric(14,2), "direction" "public"."cash_movement_direction_enum", "appliable" boolean NOT NULL DEFAULT false, "needs_cash_box" boolean NOT NULL DEFAULT false, "note" character varying(500) NOT NULL, "status" "public"."mp_reconciliation_item_status_enum" NOT NULL DEFAULT 'pending', "applied_at" TIMESTAMP WITH TIME ZONE, "applied_by_user_id" uuid, "applied_movement_id" uuid, "target_cash_box_id" uuid, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_mp_reconciliation_item_fila" UNIQUE ("reconciliation_id", "row_key"), CONSTRAINT "CHK_mp_reconciliation_item_importes" CHECK (("mp_amount" IS NULL OR "mp_amount" >= 0) AND ("extra_amount" IS NULL OR "extra_amount" >= 0)), CONSTRAINT "CHK_mp_reconciliation_item_aplicada" CHECK ("status" <> 'applied' OR ("applied_at" IS NOT NULL AND "applied_by_user_id" IS NOT NULL)), CONSTRAINT "PK_92e6db2d80198c481ed582ea181" PRIMARY KEY ("item_id"))`,
    );
    await sql(
      `CREATE INDEX "IDX_mp_reconciliation_item_corrida" ON "mp_reconciliation_item" ("reconciliation_id", "kind")`,
    );
    await sql(
      `CREATE UNIQUE INDEX "UQ_mp_reconciliation_item_aplicada" ON "mp_reconciliation_item" ("distributor_id", "row_key") WHERE "status" = 'applied'`,
    );
    await sql(
      `ALTER TABLE "mp_reconciliation" ADD CONSTRAINT "FK_722a463ce767c07f1389a46ff55" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await sql(
      `ALTER TABLE "mp_reconciliation" ADD CONSTRAINT "FK_d1d91ddfd607aec822a595428a4" FOREIGN KEY ("requested_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await sql(
      `ALTER TABLE "mp_reconciliation_item" ADD CONSTRAINT "FK_dc1ff1cfff17798f1327c10abce" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await sql(
      `ALTER TABLE "mp_reconciliation_item" ADD CONSTRAINT "FK_d2737c76d8b23a8c996b2695706" FOREIGN KEY ("applied_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await sql(
      `ALTER TABLE "mp_reconciliation_item" ADD CONSTRAINT "FK_mp_reconciliation_item_reconciliation_distribuidora" FOREIGN KEY ("reconciliation_id", "distributor_id") REFERENCES "mp_reconciliation"("reconciliation_id","distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await sql(`
      INSERT INTO "cash_category" ("distributor_id", "name", "direction", "system_code")
      SELECT d."distributor_id", c."name", c."direction"::"public"."cash_category_direction_enum", c."code"::"public"."cash_category_system_code_enum"
      FROM "distributor" d
      CROSS JOIN (VALUES
        ('Impuestos y retenciones', 'expense', 'taxes_withholdings'),
        ('Reintegros de Mercado Pago', 'income', 'mercadopago_fee_refund')
      ) AS c("name", "direction", "code")
      WHERE NOT EXISTS (
        SELECT 1 FROM "cash_category" x
        WHERE x."distributor_id" = d."distributor_id" AND x."system_code"::text = c."code"
      )
    `);
  }

  /** Aborta si hay corridas: esa historia no se descarta sola. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const filas: unknown = await queryRunner.query(
      `SELECT count(*) AS corridas FROM "mp_reconciliation"`,
    );
    const { corridas } = (filas as Array<{ corridas: string }>)[0];
    if (Number(corridas) > 0) {
      throw new Error(
        `No se puede revertir: hay ${corridas} conciliaciones con Mercado Pago`,
      );
    }
    const sql = (texto: string) => queryRunner.query(texto);
    await sql(
      `ALTER TABLE "mp_reconciliation_item" DROP CONSTRAINT "FK_mp_reconciliation_item_reconciliation_distribuidora"`,
    );
    await sql(
      `ALTER TABLE "mp_reconciliation_item" DROP CONSTRAINT "FK_d2737c76d8b23a8c996b2695706"`,
    );
    await sql(
      `ALTER TABLE "mp_reconciliation_item" DROP CONSTRAINT "FK_dc1ff1cfff17798f1327c10abce"`,
    );
    await sql(
      `ALTER TABLE "mp_reconciliation" DROP CONSTRAINT "FK_d1d91ddfd607aec822a595428a4"`,
    );
    await sql(
      `ALTER TABLE "mp_reconciliation" DROP CONSTRAINT "FK_722a463ce767c07f1389a46ff55"`,
    );
    await sql(`DROP INDEX "public"."UQ_mp_reconciliation_item_aplicada"`);
    await sql(`DROP INDEX "public"."IDX_mp_reconciliation_item_corrida"`);
    await sql(`DROP TABLE "mp_reconciliation_item"`);
    await sql(`DROP TYPE "public"."mp_reconciliation_item_status_enum"`);
    await sql(`DROP TYPE "public"."mp_reconciliation_item_kind_enum"`);
    await sql(`DROP INDEX "public"."IDX_mp_reconciliation_distribuidora"`);
    await sql(`DROP INDEX "public"."IDX_mp_reconciliation_pendientes"`);
    await sql(`DROP TABLE "mp_reconciliation"`);
    await sql(`DROP TYPE "public"."mp_reconciliation_status_enum"`);
  }
}
