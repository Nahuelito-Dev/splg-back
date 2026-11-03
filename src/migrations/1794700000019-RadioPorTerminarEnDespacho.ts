import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CU-013: los parámetros del despacho (`dispatch`) también se validan en la
 * base. `finishingRadiusMeters` (0 a 5000 m) es el nuevo; el resto repite los
 * rangos de `DispatchConfigDto`. Los pasos de radio sólo se controlan en su
 * forma (lista de 1 a 8): el orden creciente y el rango de cada paso lo
 * valida el servicio, porque un CHECK no admite subconsultas.
 */
const NUMERICOS: ReadonlyArray<[string, number, number]> = [
  ['offerTtlSeconds', 10, 300],
  ['finishingRadiusMeters', 0, 5000],
];

const condicion = (): string =>
  [
    `("params" -> 'radiusStepsKm' IS NULL OR (jsonb_typeof("params" -> 'radiusStepsKm') = 'array' AND jsonb_array_length("params" -> 'radiusStepsKm') BETWEEN 1 AND 8))`,
    ...NUMERICOS.map(
      ([k, min, max]) =>
        `("params" -> '${k}' IS NULL OR (jsonb_typeof("params" -> '${k}') = 'number' AND ("params" ->> '${k}')::numeric BETWEEN ${min} AND ${max} AND ("params" ->> '${k}')::numeric = trunc(("params" ->> '${k}')::numeric)))`,
    ),
  ].join(' AND ');

export class RadioPorTerminarEnDespacho1794700000019
  implements MigrationInterface
{
  name = 'RadioPorTerminarEnDespacho1794700000019';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_despacho" CHECK ("module" <> 'dispatch' OR (${condicion()}))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_despacho"`,
    );
  }
}
