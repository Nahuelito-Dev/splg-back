import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Despacho por tiempo de llegada (M1c):
 *  - `order_dispatch_offer.estimated_minutes` y `estimate_source`: el tiempo que
 *    se estimó al ofrecer y con qué (OSRM o línea recta). Nulos juntos: una
 *    oferta sin posición reciente del chofer no lleva estimación;
 *  - `osrmCandidateCount` (1 a 20, entero) en el CHECK de los parámetros del
 *    despacho. No hay valor que migrar: sin la clave rige el 8.
 */
const NUMERICOS_ANTERIORES: ReadonlyArray<[string, number, number]> = [
  ['offerTtlSeconds', 10, 300],
  ['finishingRadiusMeters', 0, 5000],
  ['noDriverExpiryMinutes', 1, 1440],
  ['arrivalRadiusMeters', 0, 5000],
];
const NUMERICOS: ReadonlyArray<[string, number, number]> = [
  ...NUMERICOS_ANTERIORES,
  ['osrmCandidateCount', 1, 20],
];

const condicion = (numericos: ReadonlyArray<[string, number, number]>) =>
  [
    `("params" -> 'radiusStepsKm' IS NULL OR (jsonb_typeof("params" -> 'radiusStepsKm') = 'array' AND jsonb_array_length("params" -> 'radiusStepsKm') BETWEEN 1 AND 8))`,
    ...numericos.map(
      ([k, min, max]) =>
        `("params" -> '${k}' IS NULL OR (jsonb_typeof("params" -> '${k}') = 'number' AND ("params" ->> '${k}')::numeric BETWEEN ${min} AND ${max} AND ("params" ->> '${k}')::numeric = trunc(("params" ->> '${k}')::numeric)))`,
    ),
  ].join(' AND ');

const reemplazarCheckDelDespacho = async (
  queryRunner: QueryRunner,
  numericos: ReadonlyArray<[string, number, number]>,
): Promise<void> => {
  await queryRunner.query(
    `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_despacho"`,
  );
  await queryRunner.query(
    `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_despacho" CHECK ("module" <> 'dispatch' OR (${condicion(numericos)}))`,
  );
};

export class TiempoEstimadoDeLaOferta1795000000222
  implements MigrationInterface
{
  name = 'TiempoEstimadoDeLaOferta1795000000222';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order_dispatch_offer" ADD "estimated_minutes" numeric(7,1)`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."offer_estimate_source_enum" AS ENUM('osrm', 'haversine')`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_dispatch_offer" ADD "estimate_source" "public"."offer_estimate_source_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_dispatch_offer" ADD CONSTRAINT "CHK_order_dispatch_offer_estimacion" CHECK (("estimated_minutes" IS NULL) = ("estimate_source" IS NULL) AND ("estimated_minutes" IS NULL OR "estimated_minutes" >= 0))`,
    );
    await reemplazarCheckDelDespacho(queryRunner, NUMERICOS);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await reemplazarCheckDelDespacho(queryRunner, NUMERICOS_ANTERIORES);
    await queryRunner.query(
      `ALTER TABLE "order_dispatch_offer" DROP CONSTRAINT "CHK_order_dispatch_offer_estimacion"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_dispatch_offer" DROP COLUMN "estimate_source"`,
    );
    await queryRunner.query(`DROP TYPE "public"."offer_estimate_source_enum"`);
    await queryRunner.query(
      `ALTER TABLE "order_dispatch_offer" DROP COLUMN "estimated_minutes"`,
    );
  }
}
