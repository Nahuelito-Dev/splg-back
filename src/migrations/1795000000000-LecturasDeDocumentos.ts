import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Módulo M6: lo que el sistema leyó de cada documento subido (`document_reading`),
 * uno por adjunto. El archivo sigue en S3; acá queda lo extraído, su confianza,
 * el estado, la huella del archivo (duplicados) y el costo de la lectura. El
 * adjunto y el original de un duplicado son de la misma distribuidora (FK compuestas).
 */

export class LecturasDeDocumentos1795000000000 implements MigrationInterface {
  name = 'LecturasDeDocumentos1795000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."document_reading_type_enum" AS ENUM('comprobante_de_pago', 'factura_o_remito', 'poliza', 'revision_tecnica', 'cedula_del_vehiculo', 'licencia_de_conducir', 'apto_medico', 'otro')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."document_reading_status_enum" AS ENUM('pending', 'read', 'unreadable', 'duplicate', 'failed', 'proposed', 'confirmed', 'corrected', 'rejected')`,
    );
    await queryRunner.query(
      `CREATE TABLE "document_reading" ("reading_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "attachment_id" uuid NOT NULL, "file_sha256" character(64) NOT NULL, "expected_type" "public"."document_reading_type_enum", "detected_type" "public"."document_reading_type_enum", "status" "public"."document_reading_status_enum" NOT NULL DEFAULT 'pending', "legible" boolean, "fields" jsonb NOT NULL DEFAULT '[]', "warnings" jsonb NOT NULL DEFAULT '[]', "duplicate_of_id" uuid, "model" character varying(60), "input_tokens" integer NOT NULL DEFAULT '0', "output_tokens" integer NOT NULL DEFAULT '0', "cost_usd" numeric(10,6) NOT NULL DEFAULT '0', "attempts" integer NOT NULL DEFAULT '0', "last_error" text, "read_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_document_reading_id_distribuidora" UNIQUE ("reading_id", "distributor_id"), CONSTRAINT "CHK_document_reading_huella" CHECK ("file_sha256" ~ '^[0-9a-f]{64}$'), CONSTRAINT "CHK_document_reading_consumo" CHECK ("input_tokens" >= 0 AND "output_tokens" >= 0 AND "cost_usd" >= 0 AND "attempts" >= 0), CONSTRAINT "CHK_document_reading_avisos" CHECK (jsonb_typeof("warnings") = 'array'), CONSTRAINT "CHK_document_reading_campos" CHECK (jsonb_typeof("fields") = 'array'), CONSTRAINT "CHK_document_reading_leido" CHECK (("status" IN ('read', 'unreadable', 'duplicate', 'proposed', 'confirmed', 'corrected', 'rejected')) = ("read_at" IS NOT NULL)), CONSTRAINT "CHK_document_reading_duplicado" CHECK (("status" = 'duplicate') = ("duplicate_of_id" IS NOT NULL)), CONSTRAINT "PK_11cbd828b237a44b93611736692" PRIMARY KEY ("reading_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_document_reading_huella" ON "document_reading" ("distributor_id", "file_sha256") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_document_reading_cola" ON "document_reading" ("distributor_id", "status", "created_at") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_document_reading_adjunto" ON "document_reading" ("attachment_id") WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" ADD CONSTRAINT "FK_bfe8479cad3a68cc7de2c37f1bd" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" ADD CONSTRAINT "FK_b9a50f8705d7262805c1b3718e5" FOREIGN KEY ("attachment_id") REFERENCES "attachment"("attachment_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" ADD CONSTRAINT "FK_346bcdfb64d9ba329c1a1c28511" FOREIGN KEY ("duplicate_of_id") REFERENCES "document_reading"("reading_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" ADD CONSTRAINT "FK_document_reading_duplicate_of_distribuidora" FOREIGN KEY ("duplicate_of_id", "distributor_id") REFERENCES "document_reading"("reading_id","distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" ADD CONSTRAINT "FK_document_reading_attachment_distribuidora" FOREIGN KEY ("attachment_id", "distributor_id") REFERENCES "attachment"("attachment_id","distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "document_reading" DROP CONSTRAINT "FK_document_reading_attachment_distribuidora"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" DROP CONSTRAINT "FK_document_reading_duplicate_of_distribuidora"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" DROP CONSTRAINT "FK_346bcdfb64d9ba329c1a1c28511"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" DROP CONSTRAINT "FK_b9a50f8705d7262805c1b3718e5"`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_reading" DROP CONSTRAINT "FK_bfe8479cad3a68cc7de2c37f1bd"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_document_reading_adjunto"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_document_reading_cola"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_document_reading_huella"`,
    );
    await queryRunner.query(`DROP TABLE "document_reading"`);
    await queryRunner.query(
      `DROP TYPE "public"."document_reading_status_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."document_reading_type_enum"`);
  }
}
