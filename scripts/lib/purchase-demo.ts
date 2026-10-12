/**
 * Compras para los seeds (herramienta de desarrollo; el guardia
 * `resguardoDeProduccion` la frena antes de llegar acá).
 */
import { DataSource, EntityManager } from 'typeorm';
import { GasCylinderService } from '../../src/gascylinder/gascylinder.service';
import { StockLedgerService } from '../../src/stock/application/stock-ledger.service';
import {
  StockCondition,
  StockMovementReason,
  StockReferenceType,
} from '../../src/stock/domain/stock.enums';
import {
  costoPromedioPonderado,
  totalDe,
} from '../../src/purchase/domain/purchase-rules';

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
const garrafasDelSeed = {
  async ajustarVendible(
    m: EntityManager,
    distributorId: string,
    cambios: ReadonlyArray<{ gasCylinderId: string; delta: number }>,
  ): Promise<void> {
    for (const c of [...cambios].sort((a, b) =>
      a.gasCylinderId.localeCompare(b.gasCylinderId),
    )) {
      await m.query(
        `UPDATE "gas_cylinder" SET "stock" = "stock" + $3
         WHERE "gas_cylinder_id" = $1 AND "distributor_id" = $2`,
        [c.gasCylinderId, distributorId, c.delta],
      );
    }
  },
} as unknown as GasCylinderService;

const CUIT_PLANTA = '30712345671';
const CUIT_OTRO = '30709988774';

/**
 * 2 proveedores (una planta fraccionadora y un proveedor de repuestos) y una
 * orden de compra RECIBIDA completa a la planta, con su remito. El ingreso de
 * llenas y la salida de las vacías canjeadas pasan por el ledger; el costo
 * promedio sale de la misma regla que usa la aplicación. Devuelve cuántas
 * garrafas distintas se compraron.
 */
export async function sembrarCompras(
  ds: DataSource,
  distributorId: string,
): Promise<number> {
  const ledger = new StockLedgerService(garrafasDelSeed);
  return ds.transaction(async (m) => {
    const [admin]: Array<{ user_id: string }> = await m.query(
      `SELECT "user_id" FROM "admin" WHERE "distributor_id" = $1 ORDER BY "createdAt" LIMIT 1`,
      [distributorId],
    );
    const [deposito]: Array<{ warehouse_id: string; location_id: string }> =
      await m.query(
        `SELECT w."warehouse_id", l."location_id" FROM "warehouse" w
         JOIN "stock_location" l ON l."warehouse_id" = w."warehouse_id"
         WHERE w."distributor_id" = $1 AND w."is_default" AND w."deletedAt" IS NULL`,
        [distributorId],
      );
    const productos: Array<{
      gas_cylinder_id: string;
      price: string;
    }> = await m.query(
      `SELECT "gas_cylinder_id", "price" FROM "gas_cylinder"
       WHERE "distributor_id" = $1 AND "isActive" ORDER BY "type" LIMIT 3`,
      [distributorId],
    );
    if (!admin || !deposito || productos.length === 0) return 0;

    const [planta]: Array<{ supplier_id: string }> = await m.query(
      `INSERT INTO "supplier" ("distributor_id", "business_name", "cuit", "kind", "contact_name", "phone", "email", "payment_terms_days")
       VALUES ($1, 'Gas del Litoral S.A.', $2, 'filling_plant', 'Marta Gómez', '+5493624123456', 'compras@gasdellitoral.example', 30)
       RETURNING "supplier_id"`,
      [distributorId, CUIT_PLANTA],
    );
    await m.query(
      `INSERT INTO "supplier" ("distributor_id", "business_name", "cuit", "kind", "contact_name", "phone", "payment_terms_days")
       VALUES ($1, 'Válvulas y Repuestos Chaco S.R.L.', $2, 'other', 'Raúl Benítez', '+5493624765432', 0)`,
      [distributorId, CUIT_OTRO],
    );

    const renglones = productos.map((p, i) => ({
      gasCylinderId: p.gas_cylinder_id,
      quantity: 20 + i * 10,
      // La distribuidora compra a ~65 % del precio de lista.
      unitCost: Math.round(Number(p.price) * 0.65 * 100) / 100,
    }));
    const total = totalDe(renglones);

    // Vacías que se canjean: llegaron de los clientes; el seed las carga como
    // conteo para que la planta pueda llevárselas sin dejar el depósito en negativo.
    await ledger.aplicar(m, {
      distributorId,
      referenceType: StockReferenceType.INITIAL,
      referenceId: null,
      actorUserId: null,
      vendible: 'sin-cambio',
      notes: 'Vacías para canjear con la planta (seed)',
      movimientos: renglones.map((r) => ({
        gasCylinderId: r.gasCylinderId,
        quantity: r.quantity,
        from: null,
        to: {
          locationId: deposito.location_id,
          condition: StockCondition.EMPTY,
        },
        reason: StockMovementReason.INITIAL_COUNT,
      })),
    });

    const [orden]: Array<{ purchase_order_id: string }> = await m.query(
      `INSERT INTO "purchase_order"
         ("distributor_id", "number", "supplier_id", "destination_warehouse_id", "status", "issued_at",
          "total_amount", "notes", "created_by_user_id")
       VALUES ($1, 1, $2, $3, 'received', now() - interval '3 days', $4, 'Reposición semanal (seed)', $5)
       RETURNING "purchase_order_id"`,
      [
        distributorId,
        planta.supplier_id,
        deposito.warehouse_id,
        total,
        admin.user_id,
      ],
    );
    for (const r of renglones) {
      await m.query(
        `INSERT INTO "purchase_order_item"
           ("purchase_order_id", "gas_cylinder_id", "quantity", "unit_cost", "empties_to_exchange", "received_quantity")
         VALUES ($1, $2, $3, $4, $3, $3)`,
        [orden.purchase_order_id, r.gasCylinderId, r.quantity, r.unitCost],
      );
    }

    const [remito]: Array<{ receipt_id: string }> = await m.query(
      `INSERT INTO "purchase_receipt"
         ("distributor_id", "number", "supplier_id", "purchase_order_id", "warehouse_id", "supplier_document_type",
          "supplier_document_number", "received_at", "received_by_user_id", "total_amount", "batch_id")
       VALUES ($1, 1, $2, $3, $4, 'delivery_note', '0001-00004567', now() - interval '2 days', $5, $6, gen_random_uuid())
       RETURNING "receipt_id"`,
      [
        distributorId,
        planta.supplier_id,
        orden.purchase_order_id,
        deposito.warehouse_id,
        admin.user_id,
        total,
      ],
    );
    const { batchId } = await ledger.aplicar(m, {
      distributorId,
      referenceType: StockReferenceType.PURCHASE_RECEIPT,
      referenceId: remito.receipt_id,
      actorUserId: admin.user_id,
      movimientos: renglones.flatMap((r) => [
        {
          gasCylinderId: r.gasCylinderId,
          quantity: r.quantity,
          from: null,
          to: {
            locationId: deposito.location_id,
            condition: StockCondition.FULL,
          },
          reason: StockMovementReason.PURCHASE_RECEIPT,
        },
        {
          gasCylinderId: r.gasCylinderId,
          quantity: r.quantity,
          from: {
            locationId: deposito.location_id,
            condition: StockCondition.EMPTY,
          },
          to: null,
          reason: StockMovementReason.PLANT_EMPTY_OUT,
        },
      ]),
    });
    await m.query(
      `UPDATE "purchase_receipt" SET "batch_id" = $2 WHERE "receipt_id" = $1`,
      [remito.receipt_id, batchId],
    );

    for (const r of renglones) {
      const [{ previa }]: Array<{ previa: number }> = await m.query(
        `SELECT (COALESCE(SUM("quantity"), 0) - $3)::int AS previa FROM "stock_balance"
         WHERE "distributor_id" = $1 AND "gas_cylinder_id" = $2 AND "condition" = 'full'`,
        [distributorId, r.gasCylinderId, r.quantity],
      );
      await m.query(
        `INSERT INTO "purchase_receipt_item"
           ("receipt_id", "gas_cylinder_id", "quantity_full", "quantity_empty_out", "unit_cost", "previous_average_cost", "previous_on_hand")
         VALUES ($1, $2, $3, $3, $4, NULL, $5)`,
        [remito.receipt_id, r.gasCylinderId, r.quantity, r.unitCost, previa],
      );
      await m.query(
        `UPDATE "gas_cylinder" SET "average_unit_cost" = $2 WHERE "gas_cylinder_id" = $1`,
        [
          r.gasCylinderId,
          costoPromedioPonderado({
            existenciaPrevia: previa,
            costoPrevio: null,
            cantidad: r.quantity,
            costoNuevo: r.unitCost,
          }),
        ],
      );
    }
    await m.query(
      `INSERT INTO "document_sequence" ("distributor_id", "doc_type", "last_number") VALUES ($1, 'purchase_order', 1), ($1, 'purchase_receipt', 1)
       ON CONFLICT ("distributor_id", "doc_type") DO UPDATE SET "last_number" = 1`,
      [distributorId],
    );
    return renglones.length;
  });
}
