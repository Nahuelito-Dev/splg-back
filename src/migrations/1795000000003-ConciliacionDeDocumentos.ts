import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Módulo M6, etapa 3b: la conciliación de lo leído con lo esperado. Suma a
 * `document_reading` la propuesta para el administrador y su ciclo (vigencia,
 * recordatorio y escalado), los parámetros de tolerancias y vigencias al CHECK
 * de `module_config`, y el proceso de vencimiento de propuestas al monitoreo.
 * El valor nuevo del enum no se puede quitar en `down` (Postgres no lo permite), y
 * `down` deja en `read` las lecturas que estaban propuestas.
 */

const CHECK_ANTERIOR = `("params" -> 'enabled' IS NULL OR (jsonb_typeof("params" -> 'enabled') = 'number' AND ("params" ->> 'enabled')::numeric BETWEEN 0 AND 1 AND ("params" ->> 'enabled')::numeric = trunc(("params" ->> 'enabled')::numeric))) AND ("params" -> 'frequencyMinutes' IS NULL OR (jsonb_typeof("params" -> 'frequencyMinutes') = 'number' AND ("params" ->> 'frequencyMinutes')::numeric BETWEEN 5 AND 1440 AND ("params" ->> 'frequencyMinutes')::numeric = trunc(("params" ->> 'frequencyMinutes')::numeric))) AND ("params" -> 'batchSize' IS NULL OR (jsonb_typeof("params" -> 'batchSize') = 'number' AND ("params" ->> 'batchSize')::numeric BETWEEN 1 AND 100 AND ("params" ->> 'batchSize')::numeric = trunc(("params" ->> 'batchSize')::numeric))) AND ("params" -> 'maxAttempts' IS NULL OR (jsonb_typeof("params" -> 'maxAttempts') = 'number' AND ("params" ->> 'maxAttempts')::numeric BETWEEN 1 AND 10 AND ("params" ->> 'maxAttempts')::numeric = trunc(("params" ->> 'maxAttempts')::numeric))) AND ("params" -> 'monthlyBudgetUsd' IS NULL OR (jsonb_typeof("params" -> 'monthlyBudgetUsd') = 'number' AND ("params" ->> 'monthlyBudgetUsd')::numeric BETWEEN 0 AND 10000)) AND ("params" -> 'typesMask' IS NULL OR (jsonb_typeof("params" -> 'typesMask') = 'number' AND ("params" ->> 'typesMask')::numeric BETWEEN 1 AND 255 AND ("params" ->> 'typesMask')::numeric = trunc(("params" ->> 'typesMask')::numeric)))`;

const CHECK = `("params" -> 'enabled' IS NULL OR (jsonb_typeof("params" -> 'enabled') = 'number' AND ("params" ->> 'enabled')::numeric BETWEEN 0 AND 1 AND ("params" ->> 'enabled')::numeric = trunc(("params" ->> 'enabled')::numeric))) AND ("params" -> 'frequencyMinutes' IS NULL OR (jsonb_typeof("params" -> 'frequencyMinutes') = 'number' AND ("params" ->> 'frequencyMinutes')::numeric BETWEEN 5 AND 1440 AND ("params" ->> 'frequencyMinutes')::numeric = trunc(("params" ->> 'frequencyMinutes')::numeric))) AND ("params" -> 'batchSize' IS NULL OR (jsonb_typeof("params" -> 'batchSize') = 'number' AND ("params" ->> 'batchSize')::numeric BETWEEN 1 AND 100 AND ("params" ->> 'batchSize')::numeric = trunc(("params" ->> 'batchSize')::numeric))) AND ("params" -> 'maxAttempts' IS NULL OR (jsonb_typeof("params" -> 'maxAttempts') = 'number' AND ("params" ->> 'maxAttempts')::numeric BETWEEN 1 AND 10 AND ("params" ->> 'maxAttempts')::numeric = trunc(("params" ->> 'maxAttempts')::numeric))) AND ("params" -> 'monthlyBudgetUsd' IS NULL OR (jsonb_typeof("params" -> 'monthlyBudgetUsd') = 'number' AND ("params" ->> 'monthlyBudgetUsd')::numeric BETWEEN 0 AND 10000)) AND ("params" -> 'typesMask' IS NULL OR (jsonb_typeof("params" -> 'typesMask') = 'number' AND ("params" ->> 'typesMask')::numeric BETWEEN 1 AND 255 AND ("params" ->> 'typesMask')::numeric = trunc(("params" ->> 'typesMask')::numeric))) AND ("params" -> 'amountTolerancePct' IS NULL OR (jsonb_typeof("params" -> 'amountTolerancePct') = 'number' AND ("params" ->> 'amountTolerancePct')::numeric BETWEEN 0 AND 20)) AND ("params" -> 'dateToleranceDays' IS NULL OR (jsonb_typeof("params" -> 'dateToleranceDays') = 'number' AND ("params" ->> 'dateToleranceDays')::numeric BETWEEN 0 AND 60 AND ("params" ->> 'dateToleranceDays')::numeric = trunc(("params" ->> 'dateToleranceDays')::numeric))) AND ("params" -> 'proposalTtlHours' IS NULL OR (jsonb_typeof("params" -> 'proposalTtlHours') = 'number' AND ("params" ->> 'proposalTtlHours')::numeric BETWEEN 1 AND 168 AND ("params" ->> 'proposalTtlHours')::numeric = trunc(("params" ->> 'proposalTtlHours')::numeric))) AND ("params" -> 'reminderTtlHours' IS NULL OR (jsonb_typeof("params" -> 'reminderTtlHours') = 'number' AND ("params" ->> 'reminderTtlHours')::numeric BETWEEN 1 AND 168 AND ("params" ->> 'reminderTtlHours')::numeric = trunc(("params" ->> 'reminderTtlHours')::numeric)))`;

export class ConciliacionDeDocumentos1795000000003
  implements MigrationInterface
{
  name = 'ConciliacionDeDocumentos1795000000003';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "document_reading" ADD "proposal" jsonb`);
    await q.query(
      `ALTER TABLE "document_reading" ADD "proposal_expires_at" TIMESTAMP WITH TIME ZONE`,
    );
    await q.query(
      `ALTER TABLE "document_reading" ADD "reminded_at" TIMESTAMP WITH TIME ZONE`,
    );
    await q.query(
      `ALTER TABLE "document_reading" ADD "escalated_at" TIMESTAMP WITH TIME ZONE`,
    );
    await q.query(
      `ALTER TABLE "document_reading" ADD "reconciled_at" TIMESTAMP WITH TIME ZONE`,
    );
    // Lo leído antes de la conciliación queda como ya visto: si no, el primer barrido
    // llenaría la bandeja de avisos y propuestas de documentos viejos.
    await q.query(
      `UPDATE "document_reading" SET "reconciled_at" = now() WHERE "status" IN ('read', 'unreadable', 'duplicate')`,
    );
    await q.query(
      `ALTER TABLE "document_reading" ADD CONSTRAINT "CHK_document_reading_propuesta" CHECK (("status" = 'proposed') = ("proposal" IS NOT NULL AND "proposal_expires_at" IS NOT NULL))`,
    );
    await q.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_lectura"`,
    );
    await q.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_lectura" CHECK ("module"::text <> 'document_reading' OR (${CHECK}))`,
    );
    await q.query(
      `ALTER TYPE "process_run_process_enum" ADD VALUE IF NOT EXISTS 'document_reading_proposals'`,
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(
      `DELETE FROM "process_run" WHERE "process"::text = 'document_reading_proposals'`,
    );
    await q.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_lectura"`,
    );
    await q.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_lectura" CHECK ("module"::text <> 'document_reading' OR (${CHECK_ANTERIOR}))`,
    );
    await q.query(
      `ALTER TABLE "document_reading" DROP CONSTRAINT "CHK_document_reading_propuesta"`,
    );
    await q.query(
      `UPDATE "document_reading" SET "status" = 'read' WHERE "status" = 'proposed'`,
    );
    await q.query(`ALTER TABLE "document_reading" DROP COLUMN "reconciled_at"`);
    await q.query(`ALTER TABLE "document_reading" DROP COLUMN "escalated_at"`);
    await q.query(`ALTER TABLE "document_reading" DROP COLUMN "reminded_at"`);
    await q.query(
      `ALTER TABLE "document_reading" DROP COLUMN "proposal_expires_at"`,
    );
    await q.query(`ALTER TABLE "document_reading" DROP COLUMN "proposal"`);
  }
}
