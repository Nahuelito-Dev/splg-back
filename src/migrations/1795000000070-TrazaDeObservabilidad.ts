import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Monitor O1 (DISENO-OBSERVABILIDAD §5.1): la traza de punta a punta.
 *
 *  - `process_run`: `trace_id` (request id del webhook o pedido que la disparó,
 *    o su propio `run_id`), `requested_by` (sólo las `manual`, con CHECK),
 *    `duration_ms` calculada por la base, `error_fingerprint` (16 hexadecimales)
 *    y `companies` (resumen por estado de las empresas recorridas).
 *  - `audit_log.request_id` y `admin_notification.trace_id`.
 *
 * `duration_ms` es una columna generada: TypeORM guarda su expresión en
 * `typeorm_metadata` para compararla en `migration:generate`. La tabla la crea
 * TypeORM al correr migraciones con columnas generadas; por las dudas se crea
 * acá igual, y la fila usa la base y el esquema en curso (no un nombre fijo).
 */
export class TrazaDeObservabilidad1795000000070 implements MigrationInterface {
  name = 'TrazaDeObservabilidad1795000000070';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "process_run" ADD "trace_id" character varying(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "process_run" ADD "requested_by" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "process_run" ADD "duration_ms" integer GENERATED ALWAYS AS ((round((EXTRACT(epoch FROM ("finished_at" - "started_at")) * 1000)))::integer) STORED`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "typeorm_metadata" ("type" character varying NOT NULL, "database" character varying, "schema" character varying, "table" character varying, "name" character varying, "value" text)`,
    );
    await queryRunner.query(
      `INSERT INTO "typeorm_metadata"("database", "schema", "table", "type", "name", "value") VALUES (current_database(), current_schema(), $1, $2, $3, $4)`,
      [
        'process_run',
        'GENERATED_COLUMN',
        'duration_ms',
        '(round((EXTRACT(epoch FROM ("finished_at" - "started_at")) * 1000)))::integer',
      ],
    );
    await queryRunner.query(
      `ALTER TABLE "process_run" ADD "error_fingerprint" character(16)`,
    );
    await queryRunner.query(`ALTER TABLE "process_run" ADD "companies" jsonb`);
    await queryRunner.query(
      `ALTER TABLE "audit_log" ADD "request_id" character varying(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "admin_notification" ADD "trace_id" character varying(64)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_process_run_traza" ON "process_run" ("trace_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_log_request" ON "audit_log" ("request_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_admin_notification_traza" ON "admin_notification" ("trace_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "process_run" ADD CONSTRAINT "CHK_process_run_huella" CHECK ("error_fingerprint" IS NULL OR "error_fingerprint" ~ '^[0-9a-f]{16}$')`,
    );
    await queryRunner.query(
      `ALTER TABLE "process_run" ADD CONSTRAINT "CHK_process_run_pedida_por" CHECK (("trigger_source" = 'manual') = ("requested_by" IS NOT NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "process_run" ADD CONSTRAINT "CHK_process_run_empresas" CHECK ("companies" IS NULL OR jsonb_typeof("companies") = 'object')`,
    );
    await queryRunner.query(
      `ALTER TABLE "process_run" ADD CONSTRAINT "FK_c30caa7ed6119a0ec62b40a03d7" FOREIGN KEY ("requested_by") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "process_run" DROP CONSTRAINT "FK_c30caa7ed6119a0ec62b40a03d7"`,
    );
    await queryRunner.query(
      `ALTER TABLE "process_run" DROP CONSTRAINT "CHK_process_run_empresas"`,
    );
    await queryRunner.query(
      `ALTER TABLE "process_run" DROP CONSTRAINT "CHK_process_run_pedida_por"`,
    );
    await queryRunner.query(
      `ALTER TABLE "process_run" DROP CONSTRAINT "CHK_process_run_huella"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_admin_notification_traza"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_audit_log_request"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_process_run_traza"`);
    await queryRunner.query(
      `ALTER TABLE "admin_notification" DROP COLUMN "trace_id"`,
    );
    await queryRunner.query(`ALTER TABLE "audit_log" DROP COLUMN "request_id"`);
    await queryRunner.query(
      `ALTER TABLE "process_run" DROP COLUMN "companies"`,
    );
    await queryRunner.query(
      `ALTER TABLE "process_run" DROP COLUMN "error_fingerprint"`,
    );
    await queryRunner.query(
      `DELETE FROM "typeorm_metadata" WHERE "type" = $1 AND "name" = $2 AND "database" = current_database() AND "schema" = current_schema() AND "table" = $3`,
      ['GENERATED_COLUMN', 'duration_ms', 'process_run'],
    );
    await queryRunner.query(
      `ALTER TABLE "process_run" DROP COLUMN "duration_ms"`,
    );
    await queryRunner.query(
      `ALTER TABLE "process_run" DROP COLUMN "requested_by"`,
    );
    await queryRunner.query(`ALTER TABLE "process_run" DROP COLUMN "trace_id"`);
  }
}
