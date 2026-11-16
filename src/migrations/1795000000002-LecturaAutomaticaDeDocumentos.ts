import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Módulo M6, etapa 3a: el proceso automático de lectura de documentos. Suma
 * `document_reading` a los procesos configurables y al monitoreo de corridas, y
 * los rangos de sus parámetros. El valor nuevo del enum no se usa en esta misma
 * transacción (Postgres no lo permite): el CHECK compara `module::text`.
 */

const CHECK = `("params" -> 'enabled' IS NULL OR (jsonb_typeof("params" -> 'enabled') = 'number' AND ("params" ->> 'enabled')::numeric BETWEEN 0 AND 1 AND ("params" ->> 'enabled')::numeric = trunc(("params" ->> 'enabled')::numeric))) AND ("params" -> 'frequencyMinutes' IS NULL OR (jsonb_typeof("params" -> 'frequencyMinutes') = 'number' AND ("params" ->> 'frequencyMinutes')::numeric BETWEEN 5 AND 1440 AND ("params" ->> 'frequencyMinutes')::numeric = trunc(("params" ->> 'frequencyMinutes')::numeric))) AND ("params" -> 'batchSize' IS NULL OR (jsonb_typeof("params" -> 'batchSize') = 'number' AND ("params" ->> 'batchSize')::numeric BETWEEN 1 AND 100 AND ("params" ->> 'batchSize')::numeric = trunc(("params" ->> 'batchSize')::numeric))) AND ("params" -> 'maxAttempts' IS NULL OR (jsonb_typeof("params" -> 'maxAttempts') = 'number' AND ("params" ->> 'maxAttempts')::numeric BETWEEN 1 AND 10 AND ("params" ->> 'maxAttempts')::numeric = trunc(("params" ->> 'maxAttempts')::numeric))) AND ("params" -> 'monthlyBudgetUsd' IS NULL OR (jsonb_typeof("params" -> 'monthlyBudgetUsd') = 'number' AND ("params" ->> 'monthlyBudgetUsd')::numeric BETWEEN 0 AND 10000)) AND ("params" -> 'typesMask' IS NULL OR (jsonb_typeof("params" -> 'typesMask') = 'number' AND ("params" ->> 'typesMask')::numeric BETWEEN 1 AND 255 AND ("params" ->> 'typesMask')::numeric = trunc(("params" ->> 'typesMask')::numeric)))`;

export class LecturaAutomaticaDeDocumentos1795000000002
  implements MigrationInterface
{
  name = 'LecturaAutomaticaDeDocumentos1795000000002';
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TYPE "configurable_process_enum" ADD VALUE IF NOT EXISTS 'document_reading'`,
    );
    await q.query(
      `ALTER TYPE "process_run_process_enum" ADD VALUE IF NOT EXISTS 'document_reading'`,
    );
    await q.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_lectura" CHECK ("module"::text <> 'document_reading' OR (${CHECK}))`,
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_lectura"`,
    );
    await q.query(
      `DELETE FROM "module_config" WHERE "module"::text = 'document_reading'`,
    );
    await q.query(
      `DELETE FROM "process_run" WHERE "process"::text = 'document_reading'`,
    );
    // Postgres no quita valores de un enum; los sobrantes no molestan (como en
    // `HojaDeRutaEnums`): recrear el tipo choca con los CHECK de `module_config`.
  }
}
