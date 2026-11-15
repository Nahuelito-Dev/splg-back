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
];
const MOTIVOS_DESPUES = [
  ...MOTIVOS_ANTES,
  'unverified_amount',
  'closed',
  'withdrawn',
  'superseded',
  'taken',
  'duplicate',
];
const lista = (v: string[]) => v.map((x) => `'${x}'`).join(', ');

/**
 * Asistente con IA, corrección de B3: toda consulta al modelo deja traza
 * aunque no se publique (`outcome = 'discarded'` con su motivo), así cuenta
 * para los topes.
 *
 * 1. `CHK_assistant_trace_resultado`: suma `discarded`; el motivo es nulo
 *    sólo si respondió.
 * 2. `CHK_assistant_trace_motivo`: suma `unverified_amount` (la respuesta
 *    menciona un importe que no salió de una herramienta) y los de descarte.
 * 3. `UQ_assistant_trace_disparador` pasa a índice único parcial sin las
 *    descartadas: una sola publicada por mensaje, descartadas las que haya.
 */
export class DescartesDelAsistenteConIa1795000000119
  implements MigrationInterface
{
  name = 'DescartesDelAsistenteConIa1795000000119';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "assistant_trace" DROP CONSTRAINT "CHK_assistant_trace_resultado"`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_trace" ADD CONSTRAINT "CHK_assistant_trace_resultado" CHECK ("outcome" IN ('answered', 'handed_off', 'discarded') AND ("outcome" = 'answered') = ("reason" IS NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_trace" DROP CONSTRAINT "CHK_assistant_trace_motivo"`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_trace" ADD CONSTRAINT "CHK_assistant_trace_motivo" CHECK ("reason" IS NULL OR "reason" IN (${lista(MOTIVOS_DESPUES)}))`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_trace" DROP CONSTRAINT "UQ_assistant_trace_disparador"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_assistant_trace_disparador" ON "assistant_trace" ("trigger_message_id") WHERE "outcome" <> 'discarded'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Vuelve atrás sólo si no hay descartadas ni motivos nuevos (los CHECK viejos las rechazan).
    await queryRunner.query(`DROP INDEX "UQ_assistant_trace_disparador"`);
    await queryRunner.query(
      `ALTER TABLE "assistant_trace" ADD CONSTRAINT "UQ_assistant_trace_disparador" UNIQUE ("trigger_message_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_trace" DROP CONSTRAINT "CHK_assistant_trace_motivo"`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_trace" ADD CONSTRAINT "CHK_assistant_trace_motivo" CHECK ("reason" IS NULL OR "reason" IN (${lista(MOTIVOS_ANTES)}))`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_trace" DROP CONSTRAINT "CHK_assistant_trace_resultado"`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_trace" ADD CONSTRAINT "CHK_assistant_trace_resultado" CHECK ("outcome" IN ('answered', 'handed_off') AND ("outcome" = 'handed_off') = ("reason" IS NOT NULL))`,
    );
  }
}
