import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * El admin carga la ubicación del depósito (salida de las hojas de ruta): la
 * base rechaza una fuera de rango. La columna `location` ya existe
 * (`HojaDeRuta`) y es `geometry(Point,4326)`, así que el tipo y el SRID ya los
 * cuida la columna; el CHECK cuida el rango de las coordenadas.
 */
export class UbicacionDelDeposito1795000000030 implements MigrationInterface {
  name = 'UbicacionDelDeposito1795000000030';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "warehouse" ADD CONSTRAINT "CHK_warehouse_ubicacion" CHECK ("location" IS NULL OR (ST_Y("location") BETWEEN -90 AND 90 AND ST_X("location") BETWEEN -180 AND 180))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "warehouse" DROP CONSTRAINT "CHK_warehouse_ubicacion"`,
    );
  }
}
