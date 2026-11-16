/**
 * Compras para los seeds (herramienta de desarrollo; el guardia
 * `resguardoDeProduccion` la frena antes de llegar acá).
 */
import { EntityManager } from 'typeorm';
import { GasCylinderService } from '../../src/gascylinder/gascylinder.service';

/**
 * Borra compras de las distribuidoras indicadas, hoja primero. Va ANTES que el
 * stock: remitos y órdenes cuelgan de depósitos y garrafas.
 */
export async function limpiarCompras(
  m: EntityManager,
  distributorIds: string[],
): Promise<void> {
  const ids = [distributorIds];
  await m.query(
    `DELETE FROM "purchase_receipt_item" WHERE "receipt_id" IN
       (SELECT "receipt_id" FROM "purchase_receipt" WHERE "distributor_id" = ANY($1::uuid[]))`,
    ids,
  );
  await m.query(
    `DELETE FROM "purchase_order_item" WHERE "purchase_order_id" IN
       (SELECT "purchase_order_id" FROM "purchase_order" WHERE "distributor_id" = ANY($1::uuid[]))`,
    ids,
  );
  for (const tabla of ['purchase_receipt', 'purchase_order', 'supplier']) {
    await m.query(
      `DELETE FROM "${tabla}" WHERE "distributor_id" = ANY($1::uuid[])`,
      ids,
    );
  }
  await m.query(
    `DELETE FROM "document_sequence" WHERE "distributor_id" = ANY($1::uuid[])
       AND "doc_type" IN ('purchase_order', 'purchase_receipt')`,
    ids,
  );
  await m.query(
    `UPDATE "gas_cylinder" SET "average_unit_cost" = NULL WHERE "distributor_id" = ANY($1::uuid[])`,
    ids,
  );
}

/**
 * Sólo el vendible del ledger: el seed no arma Nest, así que se da el único
 * método del servicio de garrafas que el ledger usa, con su misma regla
 * (lock de la fila, no queda negativo).
 */
export const garrafasDelSeed = {
  async ajustarVendible(
    m: EntityManager,
    distributorId: string,
    cambios: ReadonlyArray<{ gasCylinderId: string; delta: number }>,
  ): Promise<never[]> {
    for (const c of [...cambios].sort((a, b) =>
      a.gasCylinderId.localeCompare(b.gasCylinderId),
    )) {
      // Una pérdida nunca deja el vendible negativo (igual que el servicio real).
      await m.query(
        `UPDATE "gas_cylinder" SET "stock" = GREATEST(0, "stock" + $3)
         WHERE "gas_cylinder_id" = $1 AND "distributor_id" = $2`,
        [c.gasCylinderId, distributorId, c.delta],
      );
    }
    return [];
  },
} as unknown as GasCylinderService;
