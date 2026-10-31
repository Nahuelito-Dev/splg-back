import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Recompra anticipada, ronda 2: el proceso nace apagado (`enabled`, 0 o 1) y la
 * hora de ejecución se acota a horario diurno (8 a 21, hora de Argentina).
 */
const RANGOS: ReadonlyArray<[string, number, number]> = [
  ['enabled', 0, 1],
  ['minOrders', 2, 50],
  ['anticipationDays', 1, 30],
  ['invitationTtlHours', 1, 168],
  ['minIntervalDays', 1, 90],
  ['runHour', 8, 21],
  ['recentOrderDays', 1, 30],
  ['staleDays', 7, 365],
];

const RANGOS_ANTERIORES = RANGOS.filter(([k]) => k !== 'enabled').map(
  ([k, min, max]): [string, number, number] =>
    k === 'runHour' ? [k, 0, 23] : [k, min, max],
);

const rango = (k: string, min: number, max: number) =>
  `("params" -> '${k}' IS NULL OR (jsonb_typeof("params" -> '${k}') = 'number' AND ("params" ->> '${k}')::numeric BETWEEN ${min} AND ${max} AND ("params" ->> '${k}')::numeric = trunc(("params" ->> '${k}')::numeric)))`;

const check = (rangos: ReadonlyArray<[string, number, number]>) =>
  rangos.map(([k, min, max]) => rango(k, min, max)).join(' AND ');

export class RecompraM3Ronda21794660000000 implements MigrationInterface {
  name = 'RecompraM3Ronda21794660000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_recompra"`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_recompra" CHECK ("module" <> 'repurchase' OR (${check(RANGOS)}))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_recompra"`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_recompra" CHECK ("module" <> 'repurchase' OR (${check(RANGOS_ANTERIORES)}))`,
    );
  }
}
