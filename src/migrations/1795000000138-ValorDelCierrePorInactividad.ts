import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tanda 7c, primera parte: `process_run_process_enum` suma
 * `chat_inactivity_close` (la tarea que avisa y cierra las conversaciones de
 * la bandeja sin respuesta del cliente o del chofer), en su propia migración:
 * un valor nuevo de un enum no se usa en la misma transacción que lo agrega.
 */
export class ValorDelCierrePorInactividad1795000000138
  implements MigrationInterface
{
  name = 'ValorDelCierrePorInactividad1795000000138';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "process_run_process_enum" ADD VALUE IF NOT EXISTS 'chat_inactivity_close'`,
    );
  }

  /** El valor queda: Postgres no quita valores de un enum y sus corridas son historia. */
  public async down(): Promise<void> {}
}
