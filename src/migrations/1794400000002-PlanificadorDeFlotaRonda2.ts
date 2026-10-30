import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Planificador de flota, ronda 2: el CHECK de `module_config` suma los
 * parámetros nuevos (días de taller, datos viejos, anticipación por km, correo
 * al chofer), exige enteros salvo `decay` y que el taller empiece antes de
 * terminar.
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

const RANGOS_ANTERIORES = RANGOS.slice(0, 12);

const rango = (k: string, min: number, max: number, entero: boolean) =>
  `("params" -> '${k}' IS NULL OR (jsonb_typeof("params" -> '${k}') = 'number' AND ("params" ->> '${k}')::numeric BETWEEN ${min} AND ${max}${entero ? ` AND ("params" ->> '${k}')::numeric = trunc(("params" ->> '${k}')::numeric)` : ''}))`;

const CHECK_NUEVO = [
  ...RANGOS.map(([k, min, max]) => rango(k, min, max, k !== 'decay')),
  `(COALESCE(("params" ->> 'workshopStartHour')::numeric, 8) < COALESCE(("params" ->> 'workshopEndHour')::numeric, 13))`,
].join(' AND ');

const CHECK_ANTERIOR = RANGOS_ANTERIORES.map(([k, min, max]) =>
  rango(k, min, max, false),
).join(' AND ');

export class PlanificadorDeFlotaRonda21794400000002
  implements MigrationInterface
{
  name = 'PlanificadorDeFlotaRonda21794400000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_planificador"`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_planificador" CHECK ("module" <> 'fleet_planner' OR (${CHECK_NUEVO}))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_planificador"`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_planificador" CHECK ("module" <> 'fleet_planner' OR (${CHECK_ANTERIOR}))`,
    );
  }
}
