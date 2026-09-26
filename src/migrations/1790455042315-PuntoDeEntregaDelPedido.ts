import { MigrationInterface, QueryRunner } from 'typeorm';

/** Un número decimal con signo, como los guardaba el alta del pedido. */
const NUMERO = `'^\\s*-?[0-9]+(\\.[0-9]+)?\\s*$'`;

/**
 * Normalización: order.deliveryLatitude y deliveryLongitude eran dos varchar
 * con el dominio equivocado (NORMALIZACION.md §5). Pasan a deliveryPoint, un
 * punto PostGIS (geometry Point, SRID 4326) como el de las direcciones. La API
 * sigue devolviendo latitud y longitud como texto.
 *
 * Lo que no era un par de números queda en null (en la base de desarrollo, 0
 * de 404). No lleva índice espacial: el despacho lee el punto de un pedido,
 * nunca busca pedidos por cercanía.
 */
export class PuntoDeEntregaDelPedido1790455042315
  implements MigrationInterface
{
  name = 'PuntoDeEntregaDelPedido1790455042315';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order" ADD "deliveryPoint" geometry(Point,4326)`,
    );
    await queryRunner.query(
      `UPDATE "order"
          SET "deliveryPoint" = ST_SetSRID(ST_MakePoint(
                trim("deliveryLongitude")::float8,
                trim("deliveryLatitude")::float8), 4326)
        WHERE "deliveryLatitude" ~ ${NUMERO}
          AND "deliveryLongitude" ~ ${NUMERO}`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" DROP COLUMN "deliveryLatitude"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" DROP COLUMN "deliveryLongitude"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order" ADD "deliveryLatitude" character varying(50)`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD "deliveryLongitude" character varying(50)`,
    );
    await queryRunner.query(
      `UPDATE "order"
          SET "deliveryLatitude" = ST_Y("deliveryPoint")::text,
              "deliveryLongitude" = ST_X("deliveryPoint")::text
        WHERE "deliveryPoint" IS NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "order" DROP COLUMN "deliveryPoint"`);
  }
}
