import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  sentenciasDeSoporte,
  sentenciasParaQuitarSoporte,
} from './sql/sesiones-de-soporte';

/**
 * Modo soporte del administrador general (E1): `support_session` (el ciclo de
 * cada pedido y sesión, con sus CHECK), `support_access` (lo que se miró; sólo
 * agregar) y la política de soporte de cada empresa en `distributor`
 * (emergencia permitida, autoaprobación apagada). Los únicos parciales y el
 * trigger de sólo agregar salen de `sql/sesiones-de-soporte.ts`, que comparten
 * las pruebas de integración. Suma el proceso `support_session_expiry` al
 * monitoreo. La auditoría de la tabla nueva la instala
 * `AuditoriaDeLasSesionesDeSoporte`.
 */
export class SesionesDeSoporte1795000000028 implements MigrationInterface {
  name = 'SesionesDeSoporte1795000000028';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."support_session_kind" AS ENUM('consented', 'emergency')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."support_session_status" AS ENUM('pending', 'rejected', 'expired_request', 'cancelled', 'active', 'ended', 'revoked', 'expired')`,
    );
    await queryRunner.query(
      `CREATE TABLE "support_session" ("support_session_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "requested_by" uuid NOT NULL, "kind" "public"."support_session_kind" NOT NULL, "status" "public"."support_session_status" NOT NULL, "reason" text NOT NULL, "ticket_ref" character varying(60), "scope" text array NOT NULL DEFAULT '{}', "requested_minutes" smallint NOT NULL, "request_expires_at" TIMESTAMP WITH TIME ZONE, "decided_by" uuid, "decided_at" TIMESTAMP WITH TIME ZONE, "decision_note" character varying(500), "started_at" TIMESTAMP WITH TIME ZONE, "expires_at" TIMESTAMP WITH TIME ZONE, "ended_at" TIMESTAMP WITH TIME ZONE, "ended_by" uuid, "end_reason" character varying(30), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_support_session_motivo_de_fin" CHECK ("end_reason" IS NULL OR "end_reason" IN ('exit', 'revoked_by_company', 'revoked_by_platform', 'expired')), CONSTRAINT "CHK_support_session_fin" CHECK (("status" IN ('ended', 'revoked', 'expired')) = ("ended_at" IS NOT NULL AND "end_reason" IS NOT NULL)), CONSTRAINT "CHK_support_session_emergencia" CHECK ("kind" <> 'emergency' OR "decided_by" IS NULL), CONSTRAINT "CHK_support_session_duracion" CHECK ("started_at" IS NULL OR "expires_at" IS NULL OR ("expires_at" > "started_at" AND "expires_at" - "started_at" <= interval '120 minutes' AND ("kind" <> 'emergency' OR "expires_at" - "started_at" <= interval '60 minutes'))), CONSTRAINT "CHK_support_session_activa" CHECK ("status" NOT IN ('active', 'ended', 'revoked', 'expired') OR ("started_at" IS NOT NULL AND "expires_at" IS NOT NULL)), CONSTRAINT "CHK_support_session_pendiente" CHECK ("status" <> 'pending' OR "request_expires_at" IS NOT NULL), CONSTRAINT "CHK_support_session_minutos" CHECK ("requested_minutes" IN (15, 30, 60, 120)), CONSTRAINT "CHK_support_session_alcance" CHECK ("scope" <@ ARRAY['personal_data','files','exports']::text[]), CONSTRAINT "CHK_support_session_motivo" CHECK (char_length(btrim("reason")) BETWEEN 20 AND 1000), CONSTRAINT "PK_cec24a074ad1b23410a02f4957a" PRIMARY KEY ("support_session_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_support_session_historial" ON "support_session" ("distributor_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "support_access" ("support_access_id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "support_session_id" uuid NOT NULL, "distributor_id" uuid NOT NULL, "user_id" uuid NOT NULL, "at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "http_method" character varying(10) NOT NULL, "path" character varying(255) NOT NULL, "resource" character varying(60), "resource_id" character varying(64), "query" jsonb, "status_code" smallint NOT NULL, "items" integer, "masked" boolean NOT NULL DEFAULT false, "ip" character varying(45), CONSTRAINT "PK_7e63528c86c8348493a78c25267" PRIMARY KEY ("support_access_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_support_access_distribuidora" ON "support_access" ("distributor_id", "at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_support_access_sesion" ON "support_access" ("support_session_id", "at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor" ADD "support_emergency_allowed" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor" ADD "support_auto_approve" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_session" ADD CONSTRAINT "FK_49d0f7e6ce533ac40197b7dbb86" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_session" ADD CONSTRAINT "FK_e85fae310406d28f35b752b26cb" FOREIGN KEY ("requested_by") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_session" ADD CONSTRAINT "FK_e0ba317935e7b6236ce6cf6abe9" FOREIGN KEY ("decided_by") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_session" ADD CONSTRAINT "FK_19e3ba0e3bb03e25a02786e375b" FOREIGN KEY ("ended_by") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_access" ADD CONSTRAINT "FK_8858c3279fcf5f93c8a27c938c7" FOREIGN KEY ("support_session_id") REFERENCES "support_session"("support_session_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    for (const sql of sentenciasDeSoporte()) {
      await queryRunner.query(sql);
    }
    await queryRunner.query(
      `ALTER TYPE "process_run_process_enum" ADD VALUE IF NOT EXISTS 'support_session_expiry'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // El valor `support_session_expiry` del enum de procesos queda: Postgres no
    // quita valores de un enum, y sus corridas son historia (no se borran).
    for (const sql of sentenciasParaQuitarSoporte()) {
      await queryRunner.query(sql);
    }
    await queryRunner.query(
      `ALTER TABLE "support_access" DROP CONSTRAINT "FK_8858c3279fcf5f93c8a27c938c7"`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_session" DROP CONSTRAINT "FK_19e3ba0e3bb03e25a02786e375b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_session" DROP CONSTRAINT "FK_e0ba317935e7b6236ce6cf6abe9"`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_session" DROP CONSTRAINT "FK_e85fae310406d28f35b752b26cb"`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_session" DROP CONSTRAINT "FK_49d0f7e6ce533ac40197b7dbb86"`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor" DROP COLUMN "support_auto_approve"`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor" DROP COLUMN "support_emergency_allowed"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_support_access_sesion"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_support_access_distribuidora"`,
    );
    await queryRunner.query(`DROP TABLE "support_access"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_support_session_historial"`,
    );
    await queryRunner.query(`DROP TABLE "support_session"`);
    await queryRunner.query(`DROP TYPE "public"."support_session_status"`);
    await queryRunner.query(`DROP TYPE "public"."support_session_kind"`);
  }
}
