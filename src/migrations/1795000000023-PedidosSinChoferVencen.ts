import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Un pedido pendiente sin chofer vence solo.
 *
 *  - `order.available_since`: desde cuándo el pedido se puede ofrecer. Los
 *    pendientes que ya existen arrancan a contar desde que corre la migración
 *    (no desde su alta): desplegar no cancela de golpe los viejos.
 *  - `noDriverExpiryMinutes` de los parámetros del despacho (1 a 1440, entero)
 *    también se valida en la base: se rehace `CHK_module_config_despacho` con
 *    la clave nueva.
 */
const NUMERICOS_ANTERIORES: ReadonlyArray<[string, number, number]> = [
  ['offerTtlSeconds', 10, 300],
  ['finishingRadiusMeters', 0, 5000],
];
const NUMERICOS: ReadonlyArray<[string, number, number]> = [
  ...NUMERICOS_ANTERIORES,
  ['noDriverExpiryMinutes', 1, 1440],
];

const condicion = (numericos: ReadonlyArray<[string, number, number]>) =>
  [
    `("params" -> 'radiusStepsKm' IS NULL OR (jsonb_typeof("params" -> 'radiusStepsKm') = 'array' AND jsonb_array_length("params" -> 'radiusStepsKm') BETWEEN 1 AND 8))`,
    ...numericos.map(
      ([k, min, max]) =>
        `("params" -> '${k}' IS NULL OR (jsonb_typeof("params" -> '${k}') = 'number' AND ("params" ->> '${k}')::numeric BETWEEN ${min} AND ${max} AND ("params" ->> '${k}')::numeric = trunc(("params" ->> '${k}')::numeric)))`,
    ),
  ].join(' AND ');

export class PedidosSinChoferVencen1795000000023 implements MigrationInterface {
  name = 'PedidosSinChoferVencen1795000000023';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order" ADD "available_since" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `UPDATE "order" SET "available_since" = now() WHERE "status" = 'pending'`,
    );
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
    // El CHECK anterior no mira la clave nueva: lo guardado queda y se ignora.
    await queryRunner.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_despacho" CHECK ("module" <> 'dispatch' OR (${condicion(NUMERICOS_ANTERIORES)}))`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" DROP COLUMN "available_since"`,
    );
  }
}
