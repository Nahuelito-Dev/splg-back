import { EntityManager } from 'typeorm';

/**
 * Lock de la fila de un chofer (`FOR NO KEY UPDATE` sobre `delivery`): lo toman
 * TODAS las operaciones que cambian a qué está atado un chofer —poner o
 * liberar su vehículo, aceptarle o asignarle un pedido, darlo de baja— para
 * que se serialicen entre sí. `NO KEY UPDATE` y no `UPDATE`: no frena los
 * `INSERT` con clave foránea a `delivery` (una asignación de vehículo, un
 * pedido), sólo a otro que quiera el mismo lock o modificar la fila.
 *
 * Orden de locks para no generar deadlocks: primero el vehículo (`car`) si
 * hace falta, después los choferes ordenados por id. Quien toma un solo
 * chofer no tiene orden que respetar.
 *
 * Devuelve los ids que existen y NO están dados de baja DESPUÉS de tomar el
 * lock: una baja que ganó la carrera ya está confirmada y se ve acá. El
 * caller decide qué hacer con los que faltan (404).
 */
export async function bloquearChoferes(
  manager: EntityManager,
  deliveryIds: string[],
): Promise<Set<string>> {
  const filas: Array<{ delivery_id: string; deleted: boolean }> =
    await manager.query(
      `SELECT delivery_id, ("deletedAt" IS NOT NULL) AS deleted
       FROM "delivery"
       WHERE delivery_id = ANY($1)
       ORDER BY delivery_id
       FOR NO KEY UPDATE`,
      [[...deliveryIds].sort()],
    );
  return new Set(filas.filter((f) => !f.deleted).map((f) => f.delivery_id));
}

/** `bloquearChoferes` de uno solo: `true` si existe y no está dado de baja. */
export async function bloquearChoferVigente(
  manager: EntityManager,
  deliveryId: string,
): Promise<boolean> {
  return (await bloquearChoferes(manager, [deliveryId])).has(deliveryId);
}
