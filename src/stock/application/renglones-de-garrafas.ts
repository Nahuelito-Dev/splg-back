import { NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

/**
 * Antes de tocar el libro de stock: cada garrafa de los renglones del body
 * tiene que ser de la distribuidora. Si falta alguna, el 404 nombra el PRIMER
 * renglón que falla, con la numeración que ve quien mandó el pedido (1 es el
 * primero del body) y sin mostrar ids. El libro no numera: sus movimientos
 * internos no coinciden con los renglones del pedido.
 */
export async function exigirGarrafasDeLosRenglones(
  manager: EntityManager,
  distributorId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const filas: Array<{ gas_cylinder_id: string }> = await manager.query(
    `SELECT "gas_cylinder_id" FROM "gas_cylinder"
     WHERE "gas_cylinder_id" = ANY($1::uuid[]) AND "distributor_id" = $2`,
    [[...new Set(ids)], distributorId],
  );
  const vistas = new Set(filas.map((f) => f.gas_cylinder_id));
  const indice = ids.findIndex((id) => !vistas.has(id));
  if (indice !== -1) {
    throw new NotFoundException(
      `Garrafa del renglón ${indice + 1} no encontrada`,
    );
  }
}
