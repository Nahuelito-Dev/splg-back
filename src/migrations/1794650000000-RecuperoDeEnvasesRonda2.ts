import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Recupero de envases, ronda 2: la nota de la decisión tiene 10 caracteres o
 * más (la misma regla del DTO y del panel) y el CHECK de parámetros de
 * `module_config` suma `enabled` (0 o 1).
 */
const RANGOS: ReadonlyArray<[string, number, number]> = [
  ['toleranceDays', 1, 365],
  ['escalationStepDays', 1, 90],
  ['escalationAmountThreshold', 0, 100_000_000],
  ['pickupOfferTtlHours', 1, 720],
  ['pickupWindowDays', 1, 60],
  ['runHour', 0, 23],
  ['enabled', 0, 1],
];

const CHECK_PARAMETROS = (rangos: ReadonlyArray<[string, number, number]>) =>
  rangos
    .map(
      ([k, min, max]) =>
        `("params" -> '${k}' IS NULL OR (jsonb_typeof("params" -> '${k}') = 'number' AND ("params" ->> '${k}')::numeric BETWEEN ${min} AND ${max}${k === 'escalationAmountThreshold' ? '' : ` AND ("params" ->> '${k}')::numeric = trunc(("params" ->> '${k}')::numeric)`}))`,
    )
    .join(' AND ');

const ESTADO = (largo: string) =>
  `((("status" IN ('open', 'escalated', 'lost')) = ("closed_at" IS NULL)) AND ("status" NOT IN ('escalated', 'lost') OR "exhausted_at" IS NOT NULL) AND ("status" NOT IN ('deposit_charged', 'written_off', 'closed_no_charge') OR ("resolution_note" IS NOT NULL AND ${largo})))`;

export class RecuperoDeEnvasesRonda21794650000000
  implements MigrationInterface
{
  name = 'RecuperoDeEnvasesRonda21794650000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_case" DROP CONSTRAINT "CHK_recovery_case_estado"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_case" ADD CONSTRAINT "CHK_recovery_case_estado" CHECK ${ESTADO('char_length(btrim("resolution_note")) >= 10')}`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_recuperacion"`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_recuperacion" CHECK ("module" <> 'cylinder_recovery' OR (${CHECK_PARAMETROS(RANGOS)}))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_recuperacion"`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_recuperacion" CHECK ("module" <> 'cylinder_recovery' OR (${CHECK_PARAMETROS(RANGOS.slice(0, 6))}))`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_case" DROP CONSTRAINT "CHK_recovery_case_estado"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_case" ADD CONSTRAINT "CHK_recovery_case_estado" CHECK ${ESTADO(`btrim("resolution_note") <> ''`)}`,
    );
  }
}
