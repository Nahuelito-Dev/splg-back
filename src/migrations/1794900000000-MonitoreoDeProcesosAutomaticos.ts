import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F31: historial de corridas de los procesos automáticos (`process_run`). Una
 * fila por corrida; `distributor_id` nulo es un barrido global. Es telemetría
 * y no entra en la auditoría de datos.
 */
const PROCESOS = [
  'dispatch_tick',
  'fleet_planner_daily',
  'fleet_planner_expiry',
  'vehicle_usage_feed',
  'repurchase_anticipate',
  'repurchase_expiry',
  'route_batch_build',
  'route_batch_expiry',
  'cylinder_recovery',
  'attendance_open_alert',
  'receiver_retention',
  'mp_pending_reconciliation',
  'mp_cancelled_reconciliation',
  'reservations_activate',
  'reservations_expire_unpaid',
  'orders_expire_mp_unpaid',
  'payment_inbox_process',
  'payment_inbox_purge',
  's3_orphans_retry',
  'driver_settlement_generate',
  'driver_settlement_alert',
  'coverage_zone_expiry',
  'fine_due_alerts',
  'finance_reconciliation',
  'mp_reconciliation_sync',
  'fleet_alerts',
  'stock_low_alert',
  'stock_reconciliation',
  'insurance_alerts',
  'import_cleanup',
  'process_run_watch',
  'process_run_purge',
];

export class MonitoreoDeProcesosAutomaticos1794900000000
  implements MigrationInterface
{
  name = 'MonitoreoDeProcesosAutomaticos1794900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "process_run_process_enum" AS ENUM(${PROCESOS.map((p) => `'${p}'`).join(', ')})`,
    );
    await queryRunner.query(
      `CREATE TYPE "process_run_status_enum" AS ENUM('running', 'ok', 'partial', 'failed', 'skipped')`,
    );
    await queryRunner.query(
      `CREATE TYPE "process_run_trigger_enum" AS ENUM('cron', 'manual', 'webhook')`,
    );
    await queryRunner.query(
      `CREATE TABLE "process_run" ("run_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "process" "process_run_process_enum" NOT NULL, "distributor_id" uuid, "started_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "finished_at" TIMESTAMP WITH TIME ZONE, "status" "process_run_status_enum" NOT NULL DEFAULT 'running', "counters" jsonb NOT NULL DEFAULT '{}', "error" text, "trigger_source" "process_run_trigger_enum" NOT NULL DEFAULT 'cron', "instance" character varying(120) NOT NULL, CONSTRAINT "CHK_process_run_contadores" CHECK (jsonb_typeof("counters") = 'object'), CONSTRAINT "CHK_process_run_estado_fin" CHECK (("status" = 'running') = ("finished_at" IS NULL)), CONSTRAINT "CHK_process_run_fin" CHECK ("finished_at" IS NULL OR "finished_at" >= "started_at"), CONSTRAINT "PK_process_run" PRIMARY KEY ("run_id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "process_run" ADD CONSTRAINT "FK_2b4db0adeffbcee2552046e4e1a" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_process_run_distribuidora_proceso" ON "process_run" ("distributor_id", "process", "started_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_process_run_ultima" ON "process_run" ("process", "distributor_id", "started_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "process_run"`);
    await queryRunner.query(`DROP TYPE "process_run_trigger_enum"`);
    await queryRunner.query(`DROP TYPE "process_run_status_enum"`);
    await queryRunner.query(`DROP TYPE "process_run_process_enum"`);
  }
}
