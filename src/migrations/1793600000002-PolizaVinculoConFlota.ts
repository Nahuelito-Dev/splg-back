import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Seguros (F14): la póliza recuerda qué hizo en la flota, para deshacerlo al
 * cancelarla (cancelar la tarea de seguro que creó y reabrir las que dio por
 * hechas) y para sincronizarse más tarde si empieza después de que vence el
 * seguro actual (`fleet_pending`, lo completa el cron diario).
 */
export class PolizaVinculoConFlota1793600000002 implements MigrationInterface {
  name = 'PolizaVinculoConFlota1793600000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "insurance_policy" ADD "fleet_task_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_policy" ADD "fleet_closed_tasks" jsonb NOT NULL DEFAULT '[]'`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_policy" ADD "fleet_pending" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_policy" ADD CONSTRAINT "FK_insurance_policy_fleet_task" FOREIGN KEY ("fleet_task_id") REFERENCES "maintenance_task"("task_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "insurance_policy" DROP CONSTRAINT "FK_insurance_policy_fleet_task"`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_policy" DROP COLUMN "fleet_pending"`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_policy" DROP COLUMN "fleet_closed_tasks"`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_policy" DROP COLUMN "fleet_task_id"`,
    );
  }
}
