/**
 * Stock físico para los seeds (herramientas de desarrollo; el guardia
 * `resguardoDeProduccion` las frena antes de llegar acá).
 */
import { DataSource } from 'typeorm';
import { GasCylinderService } from '../../src/gascylinder/gascylinder.service';
import { StockLedgerService } from '../../src/stock/application/stock-ledger.service';
import {
  StockCondition,
  StockMovementReason,
  StockReferenceType,
} from '../../src/stock/domain/stock.enums';

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
