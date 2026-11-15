import { MigrationInterface, QueryRunner } from 'typeorm';

const MOTIVOS_ANTES = [
  'requested',
  'refusal',
  'max_tokens',
  'no_text',
  'invalid_text',
  'tool_rounds',
  'timeout',
  'rate_limited',
  'api_error',
  'unavailable',
  'reply_limit',
  'monthly_limit',
  'unverified_amount',
  'closed',
  'withdrawn',
  'superseded',
  'taken',
  'duplicate',
];
const MOTIVOS_DESPUES = [...MOTIVOS_ANTES, 'not_processed'];
const lista = (v: string[]) => v.map((x) => `'${x}'`).join(', ');

/**
 * Rescate del asistente con IA (corrección 2 de B3): los mensajes que la IA
 * tenía que atender y cuyo trabajo no corrió los deriva una tarea programada
 * cada minuto.
 *
 * 1. El proceso `assistant_ai_sweep` en el monitoreo de procesos.
 * 2. `CHK_assistant_trace_motivo` suma `not_processed`.
 */
export class RescateDelAsistenteConIa1795000000120
  implements MigrationInterface
{
  name = 'RescateDelAsistenteConIa1795000000120';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "process_run_process_enum" ADD VALUE IF NOT EXISTS 'assistant_ai_sweep'`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_trace" DROP CONSTRAINT "CHK_assistant_trace_motivo"`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_trace" ADD CONSTRAINT "CHK_assistant_trace_motivo" CHECK ("reason" IS NULL OR "reason" IN (${lista(MOTIVOS_DESPUES)}))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // El valor `assistant_ai_sweep` del enum de procesos queda: Postgres no
    // quita valores de un enum, y sus corridas son historia. El CHECK vuelve
    // atrás sólo si no hay trazas `not_processed`.
    await queryRunner.query(
      `ALTER TABLE "assistant_trace" DROP CONSTRAINT "CHK_assistant_trace_motivo"`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_trace" ADD CONSTRAINT "CHK_assistant_trace_motivo" CHECK ("reason" IS NULL OR "reason" IN (${lista(MOTIVOS_ANTES)}))`,
    );
  }
}
