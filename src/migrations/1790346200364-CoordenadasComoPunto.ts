import { MigrationInterface, QueryRunner } from 'typeorm';

/** Un texto "lat,lng" válido (con o sin espacios). */
const LAT_LNG = `'^\\s*-?[0-9]+(\\.[0-9]+)?\\s*,\\s*-?[0-9]+(\\.[0-9]+)?\\s*$'`;

/**
 * Normalización (1FN): customer.lat_lang y delivery.latLng guardaban
 * "latitud,longitud" en un texto, un valor no atómico que la base no podía
 * validar ni consultar por cercanía. Pasan a `location`, un punto PostGIS
 * (geometry Point, SRID 4326, igual que las zonas de cobertura) con índice
 * espacial. La API sigue recibiendo y devolviendo el texto "lat,lng".
 *
 * Lo que no era un par de coordenadas (en la base de desarrollo, seis
 * "12345" que dejaron pruebas anteriores a la validación) queda en null.
 */
export class CoordenadasComoPunto1790346200364 implements MigrationInterface {
  name = 'CoordenadasComoPunto1790346200364';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [tabla, columna] of [
      ['customer', 'lat_lang'],
      ['delivery', 'latLng'],
    ]) {
      await queryRunner.query(
        `ALTER TABLE "${tabla}" ADD "location" geometry(Point,4326)`,
      );
      await queryRunner.query(
        `UPDATE "${tabla}"
            SET "location" = ST_SetSRID(ST_MakePoint(
                  trim(split_part("${columna}", ',', 2))::float8,
                  trim(split_part("${columna}", ',', 1))::float8), 4326)
          WHERE "${columna}" ~ ${LAT_LNG}`,
      );
      await queryRunner.query(
        `ALTER TABLE "${tabla}" DROP COLUMN "${columna}"`,
      );
    }
    await queryRunner.query(
      `CREATE INDEX "IDX_0124ec56df62d9a9ba58cb41a2" ON "customer" USING GiST ("location")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_c270386a78fdf46067bc9a94a7" ON "delivery" USING GiST ("location")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_c270386a78fdf46067bc9a94a7"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_0124ec56df62d9a9ba58cb41a2"`,
    );
    for (const [tabla, columna] of [
      ['customer', 'lat_lang'],
      ['delivery', 'latLng'],
    ]) {
      await queryRunner.query(`ALTER TABLE "${tabla}" ADD "${columna}" text`);
      await queryRunner.query(
        `UPDATE "${tabla}"
            SET "${columna}" = ST_Y("location")::text || ',' || ST_X("location")::text
          WHERE "location" IS NOT NULL`,
      );
      await queryRunner.query(`ALTER TABLE "${tabla}" DROP COLUMN "location"`);
    }
  }
}
