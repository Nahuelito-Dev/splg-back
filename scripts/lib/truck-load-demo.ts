/**
 * Carga de camión para los seeds (herramienta de desarrollo; el guardia
 * `resguardoDeProduccion` la frena antes de llegar acá).
 */
import { EntityManager } from 'typeorm';

/** Borra las cargas de camión de las distribuidoras indicadas. Va ANTES que el stock. */
export async function limpiarCargas(
  m: EntityManager,
  distributorIds: string[],
): Promise<void> {
  const ids = [distributorIds];
  await m.query(
    `DELETE FROM "truck_load_item" WHERE "load_id" IN
       (SELECT "load_id" FROM "truck_load" WHERE "distributor_id" = ANY($1::uuid[]))`,
    ids,
  );
  await m.query(
    `DELETE FROM "truck_load" WHERE "distributor_id" = ANY($1::uuid[])`,
    ids,
  );
  await m.query(
    `DELETE FROM "document_sequence" WHERE "distributor_id" = ANY($1::uuid[])
       AND "doc_type" = 'truck_load'`,
    ids,
  );
}
