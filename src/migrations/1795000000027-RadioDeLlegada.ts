import { MigrationInterface, QueryRunner } from 'typeorm';

/** Agrega el radio por distribuidora para validar el aviso «Llegué». */
const NUMERICOS_ANTERIORES: ReadonlyArray<[string, number, number]> = [
  ['offerTtlSeconds', 10, 300],
  ['finishingRadiusMeters', 0, 5000],
  ['noDriverExpiryMinutes', 1, 1440],
];
const NUMERICOS: ReadonlyArray<[string, number, number]> = [
  ...NUMERICOS_ANTERIORES,
  ['arrivalRadiusMeters', 0, 5000],
];

const condicion = (numericos: ReadonlyArray<[string, number, number]>) =>
  [
    `("params" -> 'radiusStepsKm' IS NULL OR (jsonb_typeof("params" -> 'radiusStepsKm') = 'array' AND jsonb_array_length("params" -> 'radiusStepsKm') BETWEEN 1 AND 8))`,
    ...numericos.map(
      ([k, min, max]) =>
        `("params" -> '${k}' IS NULL OR (jsonb_typeof("params" -> '${k}') = 'number' AND ("params" ->> '${k}')::numeric BETWEEN ${min} AND ${max} AND ("params" ->> '${k}')::numeric = trunc(("params" ->> '${k}')::numeric)))`,
    ),
  ].join(' AND ');

export class RadioDeLlegada1795000000027 implements MigrationInterface {
  name = 'RadioDeLlegada1795000000027';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_despacho"`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_despacho" CHECK ("module" <> 'dispatch' OR (${condicion(NUMERICOS)}))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_despacho"`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_despacho" CHECK ("module" <> 'dispatch' OR (${condicion(NUMERICOS_ANTERIORES)}))`,
    );
  }
}
