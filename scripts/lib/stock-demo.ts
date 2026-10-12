/**
 * Stock físico para los seeds (herramientas de desarrollo; el guardia
 * `resguardoDeProduccion` las frena antes de llegar acá).
 */
import { DataSource } from 'typeorm';
import { limpiarCompras } from './purchase-demo';
import { limpiarCargas } from './truck-load-demo';
import { GasCylinderService } from '../../src/gascylinder/gascylinder.service';
import { StockLedgerService } from '../../src/stock/application/stock-ledger.service';
import {
  StockCondition,
  StockMovementReason,
  StockReferenceType,
} from '../../src/stock/domain/stock.enums';

/**
 * Borra todo el stock de las distribuidoras indicadas, en el orden de las
 * claves foráneas.
 *
 * `stock_movement` es de sólo escritura: un trigger rechaza UPDATE y DELETE
 * (es la garantía de que el libro no se edita). Un seed que regenera la base de
 * desarrollo tiene que poder vaciarlo, así que en SU transacción desactiva ese
 * trigger y lo vuelve a activar antes de confirmar. Si algo falla, el rollback
 * deja el trigger como estaba (el DDL de Postgres es transaccional). Esto NO
 * existe en la aplicación: sólo en los seeds.
 */
export async function limpiarStock(
  ds: DataSource,
  distributorIds: string[],
): Promise<void> {
  if (distributorIds.length === 0) return;
  await ds.transaction(async (m) => {
    await m.query(
      `ALTER TABLE "stock_movement" DISABLE TRIGGER "stock_movement_inmutable"`,
    );
    await limpiarCargas(m, distributorIds);
    await limpiarCompras(m, distributorIds);
    const ids = [distributorIds];
    await m.query(
      `DELETE FROM "stock_adjustment_item" WHERE "adjustment_id" IN
         (SELECT "adjustment_id" FROM "stock_adjustment" WHERE "distributor_id" = ANY($1::uuid[]))`,
      ids,
    );
    for (const tabla of [
      'stock_adjustment',
      'stock_threshold',
      'stock_reconciliation_alert',
      'stock_movement',
      'stock_balance',
      'stock_location',
      'warehouse',
    ]) {
      await m.query(
        `DELETE FROM "${tabla}" WHERE "distributor_id" = ANY($1::uuid[])`,
        ids,
      );
    }
    await m.query(
      `ALTER TABLE "stock_movement" ENABLE TRIGGER "stock_movement_inmutable"`,
    );
  });
}

/**
 * Deja el físico de la distribuidora consistente con su catálogo, PASANDO POR
 * EL LEDGER: asegura el "Depósito central" y registra como llenas (conteo
 * inicial) `stock vendible + unidades de pedidos abiertos` de cada producto, que
 * es la invariante D4. El vendible no se toca (`sin-cambio`): ya está sembrado.
 * Idempotente: sólo suma lo que falta.
 */
export async function sembrarFisico(
  ds: DataSource,
  distributorId: string,
): Promise<number> {
  // El ledger sólo usa `GasCylinderService` para mover el vendible; acá no se
  // mueve (`sin-cambio`), así que alcanza con un doble vacío.
  const ledger = new StockLedgerService({} as unknown as GasCylinderService);
  return ds.transaction(async (m) => {
    let [deposito]: Array<{ warehouse_id: string }> = await m.query(
      `SELECT "warehouse_id" FROM "warehouse"
       WHERE "distributor_id" = $1 AND "is_default" AND "deletedAt" IS NULL`,
      [distributorId],
    );
    if (!deposito) {
      [deposito] = await m.query(
        `INSERT INTO "warehouse" ("distributor_id", "name", "code", "kind", "is_default")
         VALUES ($1, 'Depósito central', 'CENTRAL', 'depot', true)
         RETURNING "warehouse_id"`,
        [distributorId],
      );
    }
    let [ubicacion]: Array<{ location_id: string }> = await m.query(
      `SELECT "location_id" FROM "stock_location" WHERE "warehouse_id" = $1`,
      [deposito.warehouse_id],
    );
    if (!ubicacion) {
      [ubicacion] = await m.query(
        `INSERT INTO "stock_location" ("distributor_id", "kind", "warehouse_id")
         VALUES ($1, 'warehouse', $2) RETURNING "location_id"`,
        [distributorId, deposito.warehouse_id],
      );
    }

    const objetivo: Array<{
      gas_cylinder_id: string;
      objetivo: number;
      actual: number;
    }> = await m.query(
      `SELECT gc."gas_cylinder_id",
              (gc."stock" + COALESCE((
                 SELECT SUM(oi."quantity") FROM "order_item" oi
                 JOIN "order" o ON o."order_id" = oi."order_id"
                 WHERE oi."gas_cylinder_id" = gc."gas_cylinder_id"
                   AND o."status" IN ('reserved', 'pending', 'accepted', 'on_the_way')), 0))::int AS objetivo,
              COALESCE((SELECT b."quantity" FROM "stock_balance" b
                        WHERE b."location_id" = $2 AND b."gas_cylinder_id" = gc."gas_cylinder_id"
                          AND b."condition" = 'full'), 0)::int AS actual
       FROM "gas_cylinder" gc WHERE gc."distributor_id" = $1`,
      [distributorId, ubicacion.location_id],
    );
    const movimientos = objetivo
      .filter((o) => o.objetivo > o.actual)
      .map((o) => ({
        gasCylinderId: o.gas_cylinder_id,
        quantity: o.objetivo - o.actual,
        from: null,
        to: {
          locationId: ubicacion.location_id,
          condition: StockCondition.FULL,
        },
        reason: StockMovementReason.INITIAL_COUNT,
      }));
    if (movimientos.length === 0) return 0;
    await ledger.aplicar(m, {
      distributorId,
      referenceType: StockReferenceType.INITIAL,
      referenceId: null,
      actorUserId: null,
      vendible: 'sin-cambio',
      notes: 'Saldo inicial del seed',
      movimientos,
    });
    return movimientos.length;
  });
}
