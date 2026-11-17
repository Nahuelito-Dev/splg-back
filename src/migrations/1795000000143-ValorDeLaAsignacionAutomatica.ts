import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tanda 8b, primera parte: `process_run_process_enum` suma `chat_auto_assign`
 * (la tarea que reparte cada minuto las conversaciones de la bandeja que
 * esperan a una persona), en su propia migración: un valor nuevo de un enum
 * no se usa en la misma transacción que lo agrega.
 */
export class ValorDeLaAsignacionAutomatica1795000000143
  implements MigrationInterface
{
  name = 'ValorDeLaAsignacionAutomatica1795000000143';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "process_run_process_enum" ADD VALUE IF NOT EXISTS 'chat_auto_assign'`,
    );
  }

  /** El valor queda: Postgres no quita valores de un enum y sus corridas son historia. */
  public async down(): Promise<void> {}
}
