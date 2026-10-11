import { EntityManager } from 'typeorm';

/**
 * Serializa el alta de un pedido con la baja de la cuenta de su cliente.
 *
 * La baja cuenta los pedidos en curso y recién después da de baja; un pedido
 * que se crea entre las dos cosas quedaría colgado de una cuenta dada de baja.
 * Las dos operaciones se cruzan en la fila del usuario:
 *
 * - el alta de pedido toma `FOR SHARE` (`bloquearCuentaParaPedido`): varios
 *   pedidos del mismo cliente conviven, pero ninguno corre mientras una baja
 *   tiene la fila;
 * - la baja toma `FOR NO KEY UPDATE` (`bloquearCuentaParaBaja`), que choca con
 *   `FOR SHARE` y, a diferencia de `FOR UPDATE`, no frena los `INSERT` con
 *   clave foránea a `user`.
 *
 * Orden de locks para no generar deadlocks: la cuenta del usuario va PRIMERO,
 * antes de la franja, el stock, el chofer o cualquier otra fila.
 *
 * Los dos devuelven el estado DESPUÉS de tomar el lock: una baja que ganó la
 * carrera ya está confirmada y se ve acá.
 */
async function leerConLock(
  manager: EntityManager,
  userId: string,
  lock: 'FOR SHARE' | 'FOR NO KEY UPDATE',
): Promise<{ existe: boolean; deBaja: boolean }> {
  const filas: Array<{ deleted: boolean }> = await manager.query(
    `SELECT ("deletedAt" IS NOT NULL) AS deleted
     FROM "user"
     WHERE user_id = $1
     ${lock}`,
    [userId],
  );
  return { existe: filas.length > 0, deBaja: filas[0]?.deleted ?? false };
}

/** Alta de pedido: `true` si la cuenta existe y no está dada de baja. */
export async function bloquearCuentaParaPedido(
  manager: EntityManager,
  userId: string,
): Promise<boolean> {
  const { existe, deBaja } = await leerConLock(manager, userId, 'FOR SHARE');
  return existe && !deBaja;
}

/** Baja de la cuenta: si existe y si ya estaba dada de baja. */
export function bloquearCuentaParaBaja(
  manager: EntityManager,
  userId: string,
): Promise<{ existe: boolean; deBaja: boolean }> {
  return leerConLock(manager, userId, 'FOR NO KEY UPDATE');
}
