import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Autocalibración del planificador de flota (M2): la tarea guarda cuándo y con qué
 * kilometraje se hizo la primera proyección y, al cerrarse, el desvío del pronóstico de uso y la primera fecha ya corregida (para medir
 * el acierto antes y después), y `module_config` suma los dos parámetros
 * (`calibrationClosures`, `calibrationMaxDays`) al rango del planificador.
 */
const RANGOS: ReadonlyArray<[string, number, number]> = [
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
  ['workshopDays', 1, 127],
  ['usageStaleDays', 1, 90],
  ['anticipationKm', 0, 1_000_000],
  ['driverEmail', 0, 1],
];
const NUEVOS: ReadonlyArray<[string, number, number]> = [
  ['calibrationClosures', 3, 20],
  ['calibrationMaxDays', 0, 60],
];

const rango = (k: string, min: number, max: number, entero: boolean) =>
  `("params" -> '${k}' IS NULL OR (jsonb_typeof("params" -> '${k}') = 'number' AND ("params" ->> '${k}')::numeric BETWEEN ${min} AND ${max}${entero ? ` AND ("params" ->> '${k}')::numeric = trunc(("params" ->> '${k}')::numeric)` : ''}))`;

const taller = `(COALESCE(("params" ->> 'workshopStartHour')::numeric, 8) < COALESCE(("params" ->> 'workshopEndHour')::numeric, 13))`;

const check = (rangos: ReadonlyArray<[string, number, number]>) =>
  [
    ...rangos.map(([k, min, max]) => rango(k, min, max, k !== 'decay')),
    taller,
  ].join(' AND ');

export class AutocalibracionDelPlanificador1795000000160
  implements MigrationInterface
{
  name = 'AutocalibracionDelPlanificador1795000000160';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" ADD "first_corrected_due_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" ADD "first_predicted_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" ADD "first_predicted_odometer_km" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" ADD "forecast_deviation_days" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" ADD CONSTRAINT "CHK_maintenance_task_desvio" CHECK ("forecast_deviation_days" IS NULL OR ("status" = 'done' AND "first_predicted_due_at" IS NOT NULL AND "first_predicted_at" IS NOT NULL AND "first_predicted_odometer_km" IS NOT NULL AND "performed_at" IS NOT NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_planificador"`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_planificador" CHECK ("module" <> 'fleet_planner' OR (${check([...RANGOS, ...NUEVOS])}))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_planificador"`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_planificador" CHECK ("module" <> 'fleet_planner' OR (${check(RANGOS)}))`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" DROP CONSTRAINT "CHK_maintenance_task_desvio"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" DROP COLUMN "forecast_deviation_days"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" DROP COLUMN "first_predicted_odometer_km"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" DROP COLUMN "first_predicted_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" DROP COLUMN "first_corrected_due_at"`,
    );
  }
}
