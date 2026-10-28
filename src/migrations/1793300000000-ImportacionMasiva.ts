import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Importación masiva desde Excel o CSV (API v2): la vista previa de cada carga
 * espera en `import_job` hasta que se confirma o vence (24 h).
 */
export class ImportacionMasiva1793300000000 implements MigrationInterface {
  name = 'ImportacionMasiva1793300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."import_job_resource_enum" AS ENUM('garrafas', 'precios', 'stock', 'proveedores')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."import_job_status_enum" AS ENUM('pending', 'with_errors', 'confirmed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "import_job" ("import_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "created_by_user_id" uuid NOT NULL, "resource" "public"."import_job_resource_enum" NOT NULL, "status" "public"."import_job_status_enum" NOT NULL, "file_name" character varying(255) NOT NULL, "total" integer NOT NULL, "valid_rows" integer NOT NULL, "error_count" integer NOT NULL, "rows" jsonb NOT NULL, "errors" jsonb NOT NULL, "summary" jsonb, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "confirmed_at" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_import_job_cuentas" CHECK ("total" >= 0 AND "valid_rows" >= 0 AND "error_count" >= 0), CONSTRAINT "CHK_import_job_confirmado" CHECK (("status" = 'confirmed') = ("confirmed_at" IS NOT NULL)), CONSTRAINT "PK_e9a71e7a1dcafd3bc13f3fd8143" PRIMARY KEY ("import_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_import_job_distribuidora" ON "import_job" ("distributor_id", "createdAt") `,
    );
    await queryRunner.query(
      `ALTER TABLE "import_job" ADD CONSTRAINT "FK_8e4ca26de56473108f5cd8ccfdd" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "import_job" ADD CONSTRAINT "FK_cccb8709b9dd7fb3976eb67063b" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "import_job" DROP CONSTRAINT "FK_cccb8709b9dd7fb3976eb67063b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "import_job" DROP CONSTRAINT "FK_8e4ca26de56473108f5cd8ccfdd"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_import_job_distribuidora"`,
    );
    await queryRunner.query(`DROP TABLE "import_job"`);
    await queryRunner.query(`DROP TYPE "public"."import_job_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."import_job_resource_enum"`);
  }
}
