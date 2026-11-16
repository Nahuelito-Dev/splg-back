import { MigrationInterface, QueryRunner } from 'typeorm';

const CHECK = `jsonb_typeof("params" -> 'enabled') = 'number' AND ("params" ->> 'enabled')::numeric IN (0, 1)`;

/** Interruptor por distribuidora: apagado si no hay una fila en module_config. */
export class InterruptorCobroDeEnvases1795000000017
  implements MigrationInterface
{
  name = 'InterruptorCobroDeEnvases1795000000017';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."configurable_process_enum" ADD VALUE IF NOT EXISTS 'container_charge'`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_cobro_envases" CHECK ("module"::text <> 'container_charge' OR (${CHECK}))`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_cobro_envases"`,
    );
    // Postgres no permite quitar un valor de un enum; las filas existentes se
    // conservan para no borrar datos de una distribuidora.
  }
}
