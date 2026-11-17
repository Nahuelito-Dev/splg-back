import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ronda 1 del probador del asistente (7b):
 *
 * 1. `assistant_trace.handoff_cause`: por qué el modelo llamó a
 *    `pasar_a_persona` (no tenía la información, no estaba seguro, lo pidió
 *    la persona, reclamo u otra). Sólo con `requested`. Las preguntas sin
 *    respuesta cuentan `no_info` y `low_confidence`.
 * 2. `assistant_regression_run.updated_at`: el latido de una corrida del lote
 *    (cada caso terminado lo actualiza); sin latido por 2 minutos, se da por
 *    perdida. Las que ya existen arrancan con el momento de la migración.
 *
 * La 138 es de otra tanda: por eso esta es la 139.
 */
export class CausaDeLaDerivacion1795000000139 implements MigrationInterface {
  name = 'CausaDeLaDerivacion1795000000139';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "assistant_regression_run" ADD "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_trace" ADD "handoff_cause" character varying(16)`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_trace" ADD CONSTRAINT "CHK_assistant_trace_causa" CHECK ("handoff_cause" IS NULL OR ("reason" = 'requested' AND "handoff_cause" IN ('no_info', 'low_confidence', 'customer_asked', 'complaint', 'other')))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "assistant_trace" DROP CONSTRAINT "CHK_assistant_trace_causa"`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_trace" DROP COLUMN "handoff_cause"`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_regression_run" DROP COLUMN "updated_at"`,
    );
  }
}
