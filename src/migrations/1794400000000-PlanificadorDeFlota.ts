import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Rangos de los parámetros del planificador de flota (CU-105) en `module_config`,
 * la misma tabla de `ESQUEMAS` en `distributor/process-config.ts`. Una clave
 * ausente vale lo de omisión; una presente tiene que ser un número dentro del rango.
 */
const RANGOS_DEL_PLANIFICADOR: ReadonlyArray<[string, number, number]> = [
  ['cronHour', 0, 23],
  ['proposalTtlHours', 1, 168],
  ['topNWindows', 1, 10],
  ['minVehiclesPerZone', 0, 100],
  ['minSampleDays', 1, 365],
  ['decay', 0, 1],
  ['horizonDays', 1, 180],
  ['minLeadDays', 0, 30],
  ['zoneLookbackDays', 1, 90],
  ['demandWeeks', 1, 26],
  ['workshopStartHour', 0, 23],
  ['workshopEndHour', 1, 24],
];

const CHECK_PLANIFICADOR = RANGOS_DEL_PLANIFICADOR.map(
  ([k, min, max]) =>
    `("params" -> '${k}' IS NULL OR (jsonb_typeof("params" -> '${k}') = 'number' AND ("params" ->> '${k}')::numeric BETWEEN ${min} AND ${max}))`,
).join(' AND ');

export class PlanificadorDeFlota1794400000000 implements MigrationInterface {
  name = 'PlanificadorDeFlota1794400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."planning_case_status_enum" AS ENUM('negotiating', 'awaiting_confirmation', 'escalated', 'confirmed', 'cancelled')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."planning_escalation_reason_enum" AS ENUM('no_driver', 'coverage', 'exhausted', 'no_windows')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."planning_window_source_enum" AS ENUM('driver_accepted', 'driver_alternative', 'admin')`,
    );
    await queryRunner.query(
      `CREATE TABLE "maintenance_planning_case" ("case_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "task_id" uuid NOT NULL, "car_id" uuid NOT NULL, "delivery_id" uuid, "status" "public"."planning_case_status_enum" NOT NULL DEFAULT 'negotiating', "projected_due_at" TIMESTAMP WITH TIME ZONE NOT NULL, "evaluated_windows" jsonb NOT NULL, "escalation_reason" "public"."planning_escalation_reason_enum", "opened_at" TIMESTAMP WITH TIME ZONE NOT NULL, "escalated_at" TIMESTAMP WITH TIME ZONE, "chosen_start" TIMESTAMP WITH TIME ZONE, "chosen_end" TIMESTAMP WITH TIME ZONE, "chosen_source" "public"."planning_window_source_enum", "resolved_at" TIMESTAMP WITH TIME ZONE, "resolved_by_user_id" uuid, "notes" text, CONSTRAINT "CHK_planning_case_estado" CHECK (("status" <> 'escalated' OR ("escalated_at" IS NOT NULL AND "escalation_reason" IS NOT NULL)) AND ("status" NOT IN ('awaiting_confirmation', 'confirmed') OR ("chosen_start" IS NOT NULL AND "chosen_source" IS NOT NULL)) AND ("status" NOT IN ('confirmed', 'cancelled') OR "resolved_at" IS NOT NULL)), CONSTRAINT "CHK_planning_case_ventana" CHECK (("chosen_start" IS NULL) = ("chosen_end" IS NULL) AND ("chosen_start" IS NULL OR "chosen_end" > "chosen_start")), CONSTRAINT "PK_807fc10cd19db79d8ca4a6b2deb" PRIMARY KEY ("case_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_planning_case_distribuidora_estado" ON "maintenance_planning_case" ("distributor_id", "status") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_planning_case_tarea_abierto" ON "maintenance_planning_case" ("task_id") WHERE "status" IN ('negotiating', 'awaiting_confirmation', 'escalated')`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" ADD "case_id" uuid NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" ADD "distributor_id" uuid NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" ADD "rejection_reason" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" ADD "alt_window_start" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" ADD "alt_window_end" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."window_proposal_status_enum" AS ENUM('pending', 'accepted', 'rejected', 'expired', 'cancelled')`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" ALTER COLUMN "status" TYPE "public"."window_proposal_status_enum" USING "status"::"text"::"public"."window_proposal_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" ALTER COLUMN "status" SET DEFAULT 'pending'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_window_proposal_caso" ON "maintenance_window_proposal" ("case_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_window_proposal_distribuidora" ON "maintenance_window_proposal" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_window_proposal_caso_pendiente" ON "maintenance_window_proposal" ("case_id") WHERE "status" = 'pending'`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" ADD CONSTRAINT "CHK_window_proposal_alternativa" CHECK (("alt_window_start" IS NULL) = ("alt_window_end" IS NULL) AND ("alt_window_start" IS NULL OR ("status" = 'rejected' AND "alt_window_end" > "alt_window_start")))`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" ADD CONSTRAINT "CHK_window_proposal_respuesta" CHECK (("status" IN ('accepted', 'rejected')) = ("responded_at" IS NOT NULL) AND ("status" <> 'rejected' OR "rejection_reason" IS NOT NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" ADD CONSTRAINT "CHK_window_proposal_ventana" CHECK ("window_end" > "window_start" AND "rank" >= 1)`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" ADD CONSTRAINT "UQ_window_proposal_caso_orden" UNIQUE ("case_id", "rank")`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_planning_case" ADD CONSTRAINT "FK_8901256dcd36ed9976d8554f72a" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_planning_case" ADD CONSTRAINT "FK_61ea21a0f1687eec9c4ca0f97ba" FOREIGN KEY ("task_id") REFERENCES "maintenance_task"("task_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_planning_case" ADD CONSTRAINT "FK_cb75e8eba9257d9b774db1e3a3d" FOREIGN KEY ("car_id") REFERENCES "car"("car_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_planning_case" ADD CONSTRAINT "FK_dcb2780c8fa301e02eb3fb1d3ec" FOREIGN KEY ("delivery_id") REFERENCES "delivery"("delivery_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_planning_case" ADD CONSTRAINT "FK_813cec16922d27ddfa01438f363" FOREIGN KEY ("resolved_by_user_id") REFERENCES "user"("user_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" ADD CONSTRAINT "FK_f63ad3516a0006f739de02a99eb" FOREIGN KEY ("case_id") REFERENCES "maintenance_planning_case"("case_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_planificador" CHECK ("module" <> 'fleet_planner' OR (${CHECK_PLANIFICADOR}))`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" ADD CONSTRAINT "FK_1c8710761954a95279ad2d68513" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_planificador"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" DROP CONSTRAINT "FK_1c8710761954a95279ad2d68513"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" DROP CONSTRAINT "FK_f63ad3516a0006f739de02a99eb"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_planning_case" DROP CONSTRAINT "FK_813cec16922d27ddfa01438f363"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_planning_case" DROP CONSTRAINT "FK_dcb2780c8fa301e02eb3fb1d3ec"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_planning_case" DROP CONSTRAINT "FK_cb75e8eba9257d9b774db1e3a3d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_planning_case" DROP CONSTRAINT "FK_61ea21a0f1687eec9c4ca0f97ba"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_planning_case" DROP CONSTRAINT "FK_8901256dcd36ed9976d8554f72a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" DROP CONSTRAINT "UQ_window_proposal_caso_orden"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" DROP CONSTRAINT "CHK_window_proposal_ventana"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" DROP CONSTRAINT "CHK_window_proposal_respuesta"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" DROP CONSTRAINT "CHK_window_proposal_alternativa"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_window_proposal_caso_pendiente"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_window_proposal_distribuidora"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_window_proposal_caso"`);
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" ALTER COLUMN "status" TYPE "public"."proposal_status_enum" USING "status"::"text"::"public"."proposal_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" ALTER COLUMN "status" SET DEFAULT 'pending'`,
    );
    await queryRunner.query(`DROP TYPE "public"."window_proposal_status_enum"`);
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" DROP COLUMN "alt_window_end"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" DROP COLUMN "alt_window_start"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" DROP COLUMN "rejection_reason"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" DROP COLUMN "distributor_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" DROP COLUMN "case_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_planning_case_tarea_abierto"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_planning_case_distribuidora_estado"`,
    );
    await queryRunner.query(`DROP TABLE "maintenance_planning_case"`);
    await queryRunner.query(`DROP TYPE "public"."planning_window_source_enum"`);
    await queryRunner.query(
      `DROP TYPE "public"."planning_escalation_reason_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."planning_case_status_enum"`);
  }
}
