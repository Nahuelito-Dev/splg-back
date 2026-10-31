import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M4: el interruptor `enabled` (apagado por omisión) y el margen de espera del
 * despacho individual (`batchingHoldMinutes`) entran en los parámetros de
 * `route_batching`. Se vuelve a crear el CHECK con las dos claves nuevas.
 */
const CLAVES: ReadonlyArray<[string, number, number, boolean]> = [
  ['maxBatchSize', 2, 20, true],
  ['groupingRadiusKm', 0.5, 50, false],
  ['slotToleranceMinutes', 0, 480, true],
  ['offerTtlSeconds', 10, 600, true],
  ['evaluationFrequencyMinutes', 1, 1440, true],
  ['batchingHoldMinutes', 0, 720, true],
  ['enabled', 0, 1, true],
];

const condicion = (claves: typeof CLAVES): string =>
  claves
    .map(
      ([k, min, max, entero]) =>
        `("params" -> '${k}' IS NULL OR (jsonb_typeof("params" -> '${k}') = 'number' AND ("params" ->> '${k}')::numeric BETWEEN ${min} AND ${max}${entero ? ` AND ("params" ->> '${k}')::numeric = trunc(("params" ->> '${k}')::numeric)` : ''}))`,
    )
    .join(' AND ');

const reemplazar = async (
  queryRunner: QueryRunner,
  claves: typeof CLAVES,
): Promise<void> => {
  await queryRunner.query(
    `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_agrupacion"`,
  );
  await queryRunner.query(
    `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_agrupacion" CHECK ("module" <> 'route_batching' OR (${condicion(claves)}))`,
  );
};

export class AgrupacionConInterruptor1794700000002
  implements MigrationInterface
{
  name = 'AgrupacionConInterruptor1794700000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await reemplazar(queryRunner, CLAVES);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await reemplazar(
      queryRunner,
      CLAVES.filter(([k]) => k !== 'enabled' && k !== 'batchingHoldMinutes'),
    );
  }
}
