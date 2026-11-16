import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Módulo M6, etapa 4a: la decisión del administrador sobre una propuesta
 * (confirmar, corregir o rechazar), lo que ejecutó y los ejemplos de corrección
 * que el lector usa después. Una lectura decidida conserva su propuesta: el
 * CHECK de la propuesta pasa a exigirla sólo mientras está `proposed`.
 */

export class DecisionDeLecturas1795000000005 implements MigrationInterface {
  name = 'DecisionDeLecturas1795000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "document_reading_example" ("example_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "document_type" "public"."document_reading_type_enum" NOT NULL, "field" character varying(60) NOT NULL, "read_value" text, "correct_value" text NOT NULL, "source_reading_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_document_reading_example_source_field" UNIQUE ("source_reading_id", "field"), CONSTRAINT "PK_d3957d714f46440120618404494" PRIMARY KEY ("example_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_document_reading_example_tipo" ON "document_reading_example" ("distributor_id", "document_type", "created_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" DROP CONSTRAINT "CHK_document_reading_propuesta"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" ADD CONSTRAINT "CHK_document_reading_propuesta" CHECK ("status" <> 'proposed' OR ("proposal" IS NOT NULL AND "proposal_expires_at" IS NOT NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" ADD "decided_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" ADD "decided_by_user_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" ADD "decision_note" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" ADD "corrections" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" ADD "executed" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" ADD CONSTRAINT "CHK_document_reading_executed" CHECK (NOT "executed" OR "status" IN ('confirmed','corrected'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" ADD CONSTRAINT "CHK_document_reading_corrected" CHECK (("status" = 'corrected') = ("corrections" IS NOT NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" ADD CONSTRAINT "CHK_document_reading_rejected_note" CHECK ("status" <> 'rejected' OR "decision_note" IS NOT NULL)`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" ADD CONSTRAINT "CHK_document_reading_decision" CHECK (("status" IN ('confirmed','corrected','rejected')) = ("decided_at" IS NOT NULL AND "decided_by_user_id" IS NOT NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" ADD CONSTRAINT "FK_ef9e26d2f5ba63e94ebe95d61f0" FOREIGN KEY ("decided_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading_example" ADD CONSTRAINT "FK_65cb2fa62488a1401a974522ea8" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading_example" ADD CONSTRAINT "FK_document_reading_example_source_reading_distribuidora" FOREIGN KEY ("source_reading_id", "distributor_id") REFERENCES "document_reading"("reading_id","distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "document_reading_example" DROP CONSTRAINT "FK_document_reading_example_source_reading_distribuidora"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading_example" DROP CONSTRAINT "FK_65cb2fa62488a1401a974522ea8"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" DROP CONSTRAINT "FK_ef9e26d2f5ba63e94ebe95d61f0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" DROP CONSTRAINT "CHK_document_reading_decision"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" DROP CONSTRAINT "CHK_document_reading_rejected_note"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" DROP CONSTRAINT "CHK_document_reading_corrected"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" DROP CONSTRAINT "CHK_document_reading_executed"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" DROP COLUMN "executed"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" DROP COLUMN "corrections"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" DROP COLUMN "decision_note"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" DROP COLUMN "decided_by_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" DROP COLUMN "decided_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_document_reading_example_tipo"`,
    );
    await queryRunner.query(`DROP TABLE "document_reading_example"`);
    // La fórmula anterior no admite una propuesta fuera de `proposed`.
    await queryRunner.query(
      `UPDATE "document_reading" SET "proposal" = NULL, "proposal_expires_at" = NULL WHERE "status" <> 'proposed'`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" DROP CONSTRAINT "CHK_document_reading_propuesta"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" ADD CONSTRAINT "CHK_document_reading_propuesta" CHECK (("status" = 'proposed') = ("proposal" IS NOT NULL AND "proposal_expires_at" IS NOT NULL))`,
    );
  }
}
