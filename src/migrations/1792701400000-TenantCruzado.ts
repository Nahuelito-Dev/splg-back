import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  CLAVES_CRUZADAS,
  nombreDeLaClave,
  nombreDelUnicoDelPadre,
  PADRES,
  sqlDeClave,
  sqlDeUnicoDelPadre,
  sqlDeViolaciones,
} from './sql/tenant-cruzado';

/**
 * Tenant cruzado (tanda V2 de validaciones): claves foráneas compuestas
 * `(id, distributor_id)` para que dinero, stock, pedidos, rendiciones, cargas y
 * compras sólo referencien filas de su misma distribuidora (ver
 * `sql/tenant-cruzado.ts`).
 *
 * Antes de crearlas cuenta las filas que hoy las violarían (en `splg_db` eran 0
 * en las 55). Si en otra base hubiera alguna, la migración aborta con la lista:
 * esa historia no se borra ni se reescribe sola, se resuelve a mano.
 */
export class TenantCruzado1792701400000 implements MigrationInterface {
  name = 'TenantCruzado1792701400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const violadas: string[] = [];
    for (const [hijo, columna, padre] of CLAVES_CRUZADAS) {
      const [{ total }] = (await queryRunner.query(
        sqlDeViolaciones(hijo, columna, padre),
      )) as Array<{ total: number }>;
      if (total > 0) violadas.push(`${hijo}.${columna} → ${padre}: ${total}`);
    }
    if (violadas.length > 0) {
      throw new Error(
        `No se pueden crear las claves por distribuidora: hay filas que apuntan a otra distribuidora (${violadas.join('; ')}). Revisalas (la misma consulta con el hijo y el padre indicados: WHERE p.distributor_id <> c.distributor_id) y corregí el dato antes de reintentar.`,
      );
    }
    for (const padre of PADRES) {
      await queryRunner.query(sqlDeUnicoDelPadre(padre));
    }
    for (const [hijo, columna, padre] of CLAVES_CRUZADAS) {
      await queryRunner.query(sqlDeClave(hijo, columna, padre));
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [hijo, columna] of [...CLAVES_CRUZADAS].reverse()) {
      await queryRunner.query(
        `ALTER TABLE "${hijo}" DROP CONSTRAINT "${nombreDeLaClave(hijo, columna)}"`,
      );
    }
    for (const padre of PADRES) {
      await queryRunner.query(
        `ALTER TABLE "${padre}" DROP CONSTRAINT "${nombreDelUnicoDelPadre(padre)}"`,
      );
    }
  }
}
