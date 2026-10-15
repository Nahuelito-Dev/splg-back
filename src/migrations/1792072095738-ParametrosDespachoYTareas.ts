import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agrega `dispatch` (CU-171) y `scheduled_tasks` (CU-173) a `configurable_process_enum`.
 * Al revertir se borran las filas de esos dos procesos: el valor ya no existe.
 */
export class ParametrosDespachoYTareas1792072095738
  implements MigrationInterface
{
  name = 'ParametrosDespachoYTareas1792072095738';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "UQ_module_config_distributor_module"`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."configurable_process_enum" RENAME TO "configurable_process_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."configurable_process_enum" AS ENUM('fleet_planner', 'repurchase', 'route_batching', 'cylinder_recovery', 'express_dispatch', 'stock_control', 'dispatch', 'scheduled_tasks')`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" ALTER COLUMN "module" TYPE "public"."configurable_process_enum" USING "module"::"text"::"public"."configurable_process_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."configurable_process_enum_old"`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "UQ_module_config_distributor_module" UNIQUE ("distributor_id", "module")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "module_config" WHERE "module" IN ('dispatch', 'scheduled_tasks')`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "UQ_module_config_distributor_module"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."configurable_process_enum_old" AS ENUM('fleet_planner', 'repurchase', 'route_batching', 'cylinder_recovery', 'express_dispatch', 'stock_control')`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" ALTER COLUMN "module" TYPE "public"."configurable_process_enum_old" USING "module"::"text"::"public"."configurable_process_enum_old"`,
    );
    await queryRunner.query(`DROP TYPE "public"."configurable_process_enum"`);
    await queryRunner.query(
      `ALTER TYPE "public"."configurable_process_enum_old" RENAME TO "configurable_process_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "UQ_module_config_distributor_module" UNIQUE ("distributor_id", "module")`,
    );
  }
}
