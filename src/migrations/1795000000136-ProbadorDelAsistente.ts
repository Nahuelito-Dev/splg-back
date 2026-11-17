import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Probador, preguntas sin respuesta y lote de regresión del asistente del
 * chat (DISENO-CH-BOT §7, tanda 7b):
 *
 * 1. `assistant_test_usage`: los tokens que gastan las pruebas (probador y
 *    lote), aparte de `assistant_trace` (no cuentan en las métricas) pero
 *    sumados al tope mensual. De la empresa (C3) o del soporte de la
 *    plataforma (C1, sin empresa). Nunca el texto.
 * 2. `assistant_unanswered_resolution`: lo que se hizo con un grupo de
 *    preguntas sin respuesta (pregunta en borrador o descarte), por su id;
 *    una por grupo y dueño. La pregunta creada es de la misma base (clave
 *    cruzada `(faq_id, distributor_id)`, con su único en `assistant_faq`).
 * 3. `assistant_regression_case`: los casos del lote de cada empresa, con
 *    baja lógica y una pregunta por empresa entre los vigentes.
 * 4. `assistant_regression_run`: las corridas del lote, una en curso por
 *    empresa.
 * 5. `assistant_faq`: la respuesta puede quedar vacía (borrador).
 */
export class ProbadorDelAsistente1795000000136 implements MigrationInterface {
  name = 'ProbadorDelAsistente1795000000136';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "assistant_unanswered_resolution" ("resolution_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid, "channel" character varying(20) NOT NULL, "question_key" character varying(32) NOT NULL, "status" character varying(10) NOT NULL, "faq_id" uuid, "resolved_by" uuid, "resolved_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_assistant_unanswered_resolution_grupo" CHECK ("question_key" ~ '^[0-9a-f]{32}$'), CONSTRAINT "CHK_assistant_unanswered_resolution_estado" CHECK ("status" IN ('resolved', 'dismissed') AND ("status" = 'resolved') = ("faq_id" IS NOT NULL)), CONSTRAINT "CHK_assistant_unanswered_resolution_canal" CHECK ("channel" IN ('platform_chat', 'staff_customer') AND ("channel" = 'staff_customer') = ("distributor_id" IS NOT NULL)), CONSTRAINT "PK_assistant_unanswered_resolution" PRIMARY KEY ("resolution_id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "assistant_regression_run" ("run_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "status" character varying(10) NOT NULL, "total" integer NOT NULL, "passed" integer NOT NULL DEFAULT '0', "failed" integer NOT NULL DEFAULT '0', "errored" integer NOT NULL DEFAULT '0', "results" jsonb NOT NULL DEFAULT '[]', "started_by" uuid, "started_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "finished_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "CHK_assistant_regression_run_resultados" CHECK (jsonb_typeof("results") = 'array'), CONSTRAINT "CHK_assistant_regression_run_conteos" CHECK ("total" BETWEEN 0 AND 100 AND "passed" >= 0 AND "failed" >= 0 AND "errored" >= 0 AND "passed" + "failed" + "errored" <= "total"), CONSTRAINT "CHK_assistant_regression_run_estado" CHECK ("status" IN ('running', 'finished', 'failed') AND ("status" = 'running') = ("finished_at" IS NULL)), CONSTRAINT "PK_assistant_regression_run" PRIMARY KEY ("run_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_assistant_regression_run_distribuidora" ON "assistant_regression_run" ("distributor_id", "started_at") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_assistant_regression_run_en_curso" ON "assistant_regression_run" ("distributor_id") WHERE "status" = 'running'`,
    );
    await queryRunner.query(
      `CREATE TABLE "assistant_regression_case" ("case_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "question" character varying(500) NOT NULL, "expected" character varying(8) NOT NULL, "must_mention" jsonb NOT NULL DEFAULT '[]', "created_by" uuid, "updated_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "CHK_assistant_regression_case_menciones" CHECK (jsonb_typeof("must_mention") = 'array' AND jsonb_array_length("must_mention") <= 10 AND ("expected" = 'answer' OR jsonb_array_length("must_mention") = 0)), CONSTRAINT "CHK_assistant_regression_case_esperado" CHECK ("expected" IN ('answer', 'handoff')), CONSTRAINT "CHK_assistant_regression_case_pregunta" CHECK (char_length(btrim("question")) BETWEEN 2 AND 500), CONSTRAINT "PK_assistant_regression_case" PRIMARY KEY ("case_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_assistant_regression_case_distribuidora" ON "assistant_regression_case" ("distributor_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "assistant_test_usage" ("usage_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid, "channel" character varying(20) NOT NULL, "kind" character varying(12) NOT NULL, "model" character varying(60) NOT NULL, "outcome" character varying(12) NOT NULL, "reason" character varying(20), "input_tokens" integer NOT NULL DEFAULT '0', "output_tokens" integer NOT NULL DEFAULT '0', "cache_read_tokens" integer NOT NULL DEFAULT '0', "cache_creation_tokens" integer NOT NULL DEFAULT '0', "tools_used" jsonb NOT NULL DEFAULT '[]', "latency_ms" integer NOT NULL, "created_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_assistant_test_usage_herramientas" CHECK (jsonb_typeof("tools_used") = 'array'), CONSTRAINT "CHK_assistant_test_usage_tokens" CHECK ("input_tokens" >= 0 AND "output_tokens" >= 0 AND "cache_read_tokens" >= 0 AND "cache_creation_tokens" >= 0 AND "latency_ms" >= 0), CONSTRAINT "CHK_assistant_test_usage_motivo" CHECK ("reason" IS NULL OR "reason" IN ('requested', 'refusal', 'max_tokens', 'no_text', 'invalid_text', 'tool_rounds', 'timeout', 'rate_limited', 'api_error', 'unavailable', 'reply_limit', 'monthly_limit', 'unverified_amount', 'not_processed')), CONSTRAINT "CHK_assistant_test_usage_resultado" CHECK ("outcome" IN ('answered', 'handed_off') AND ("outcome" = 'answered') = ("reason" IS NULL)), CONSTRAINT "CHK_assistant_test_usage_tipo" CHECK ("kind" IN ('preview', 'regression')), CONSTRAINT "CHK_assistant_test_usage_canal" CHECK ("channel" IN ('platform_chat', 'staff_customer') AND ("channel" = 'staff_customer') = ("distributor_id" IS NOT NULL)), CONSTRAINT "PK_assistant_test_usage" PRIMARY KEY ("usage_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_assistant_test_usage_mes" ON "assistant_test_usage" ("channel", "distributor_id", "created_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_faq" ADD CONSTRAINT "UQ_assistant_faq_id_distribuidora" UNIQUE ("faq_id", "distributor_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_unanswered_resolution" ADD CONSTRAINT "FK_assistant_unanswered_resolution_distributor" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_unanswered_resolution" ADD CONSTRAINT "FK_assistant_unanswered_resolution_faq" FOREIGN KEY ("faq_id") REFERENCES "assistant_faq"("faq_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_unanswered_resolution" ADD CONSTRAINT "FK_assistant_unanswered_resolution_faq_distribuidora" FOREIGN KEY ("faq_id", "distributor_id") REFERENCES "assistant_faq"("faq_id","distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_regression_run" ADD CONSTRAINT "FK_assistant_regression_run_distributor" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_regression_case" ADD CONSTRAINT "FK_assistant_regression_case_distributor" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_test_usage" ADD CONSTRAINT "FK_assistant_test_usage_distributor" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    // Únicos con expresión (la entidad los declara con `synchronize: false`).
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_assistant_regression_case_pregunta_vigente" ON "assistant_regression_case" ("distributor_id", lower(btrim("question"))) WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_assistant_unanswered_resolution_grupo" ON "assistant_unanswered_resolution" ("channel", COALESCE("distributor_id", '00000000-0000-0000-0000-000000000000'::uuid), "question_key")`,
    );
    // Preguntas en borrador: la respuesta puede quedar vacía (el asistente no las usa).
    await queryRunner.query(
      `ALTER TABLE "assistant_faq" DROP CONSTRAINT "CHK_assistant_faq_respuesta"`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_faq" ADD CONSTRAINT "CHK_assistant_faq_respuesta" CHECK (char_length(btrim("answer")) <= 1500)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Los borradores no entran en el CHECK anterior: se dan de baja (baja
    // lógica, queda en la auditoría) antes de reponerlo. NOT VALID porque las
    // filas dadas de baja siguen con la respuesta vacía.
    await queryRunner.query(
      `UPDATE "assistant_faq" SET "deleted_at" = now(), "updated_at" = now()
        WHERE btrim("answer") = '' AND "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_faq" DROP CONSTRAINT "CHK_assistant_faq_respuesta"`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_faq" ADD CONSTRAINT "CHK_assistant_faq_respuesta" CHECK (char_length(btrim("answer")) BETWEEN 1 AND 1500) NOT VALID`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_assistant_unanswered_resolution_grupo"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_assistant_regression_case_pregunta_vigente"`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_test_usage" DROP CONSTRAINT "FK_assistant_test_usage_distributor"`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_regression_case" DROP CONSTRAINT "FK_assistant_regression_case_distributor"`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_regression_run" DROP CONSTRAINT "FK_assistant_regression_run_distributor"`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_unanswered_resolution" DROP CONSTRAINT "FK_assistant_unanswered_resolution_faq_distribuidora"`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_unanswered_resolution" DROP CONSTRAINT "FK_assistant_unanswered_resolution_faq"`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_unanswered_resolution" DROP CONSTRAINT "FK_assistant_unanswered_resolution_distributor"`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_faq" DROP CONSTRAINT "UQ_assistant_faq_id_distribuidora"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_assistant_test_usage_mes"`,
    );
    await queryRunner.query(`DROP TABLE "assistant_test_usage"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_assistant_regression_case_distribuidora"`,
    );
    await queryRunner.query(`DROP TABLE "assistant_regression_case"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_assistant_regression_run_en_curso"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_assistant_regression_run_distribuidora"`,
    );
    await queryRunner.query(`DROP TABLE "assistant_regression_run"`);
    await queryRunner.query(`DROP TABLE "assistant_unanswered_resolution"`);
  }
}
