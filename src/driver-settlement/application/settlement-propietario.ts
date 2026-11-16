import { EntityManager } from 'typeorm';
import { RendicionNoEncontradaError } from '../domain/errors/driver-settlement.errors';

/**
 * Una rendición es del chofer en sesión si su chofer es ese usuario. Se mira la
 * fila de `delivery` tal cual está (con o sin baja lógica): presentar y la vista
 * previa deciden igual, y una rendición ajena es 404, como si no existiera.
 */
export async function exigirRendicionDelUsuario(
  manager: EntityManager,
  rendicion: { settlementId: string; deliveryId: string },
  userId: string,
): Promise<void> {
  const [chofer]: Array<{ user_id: string }> = await manager.query(
    `SELECT "user_id" FROM "delivery" WHERE "delivery_id" = $1`,
    [rendicion.deliveryId],
  );
  if (chofer?.user_id !== userId) {
    throw new RendicionNoEncontradaError(rendicion.settlementId);
  }
}
