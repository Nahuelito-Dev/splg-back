/**
 * Carga de camión para los seeds (herramienta de desarrollo; el guardia
 * `resguardoDeProduccion` la frena antes de llegar acá).
 */
import { EntityManager, DataSource } from 'typeorm';
import { diaArgentino } from '../../src/common/utils/dias-argentina';
import { StockLedgerService } from '../../src/stock/application/stock-ledger.service';
import {
  StockCondition,
  StockMovementReason,
  StockReferenceType,
} from '../../src/stock/domain/stock.enums';
import {
  esperadoDe,
  planDeCierre,
} from '../../src/truck-load/domain/truck-load-rules';
import { garrafasDelSeed } from './purchase-demo';

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

const UN_DIA_MS = 24 * 60 * 60 * 1000;

/**
 * UNA carga de ayer ya rendida con diferencia, para que las pantallas y los
 * informes tengan qué mostrar: sale con 12 llenas y 4 vacías del primer
 * producto, vuelven 10 llenas y 4 vacías, y las 2 llenas que faltan quedan como
 * merma con su nota. Todo pasa por el ledger y por las mismas reglas que usa la
 * aplicación (`planDeCierre`). Devuelve cuántas cargas se sembraron (0 si no hay
 * un chofer con vehículo en uso o stock en el depósito).
 */
export async function sembrarCarga(
  ds: DataSource,
  distributorId: string,
): Promise<number> {
  const ledger = new StockLedgerService(garrafasDelSeed);
  return ds.transaction(async (m) => {
    const [admin]: Array<{ user_id: string }> = await m.query(
      `SELECT "user_id" FROM "admin" WHERE "distributor_id" = $1 ORDER BY "createdAt" LIMIT 1`,
      [distributorId],
    );
    const [asignacion]: Array<{ car_id: string; delivery_id: string }> =
      await m.query(
        `SELECT va."car_id", va."delivery_id" FROM "vehicle_assignment" va
         WHERE va."distributor_id" = $1 AND va."released_at" IS NULL
         ORDER BY va."assigned_at" LIMIT 1`,
        [distributorId],
      );
    const [deposito]: Array<{ location_id: string }> = await m.query(
      `SELECT l."location_id" FROM "warehouse" w
       JOIN "stock_location" l ON l."warehouse_id" = w."warehouse_id"
       WHERE w."distributor_id" = $1 AND w."is_default" AND w."deletedAt" IS NULL`,
      [distributorId],
    );
    if (!admin || !asignacion || !deposito) return 0;
    const [producto]: Array<{ gas_cylinder_id: string }> = await m.query(
      `SELECT b."gas_cylinder_id" FROM "stock_balance" b
       WHERE b."location_id" = $1 AND b."condition" = 'full' AND b."quantity" >= 12
       ORDER BY b."quantity" DESC LIMIT 1`,
      [deposito.location_id],
    );
    if (!producto) return 0;

    const salioEl = new Date(Date.now() - UN_DIA_MS + 8 * 60 * 60 * 1000);
    const volvioEl = new Date(salioEl.getTime() + 9 * 60 * 60 * 1000);
    await m.query(
      `INSERT INTO "stock_location" ("distributor_id", "kind", "car_id")
       VALUES ($1, 'vehicle', $2) ON CONFLICT ("car_id") DO NOTHING`,
      [distributorId, asignacion.car_id],
    );
    const [camion]: Array<{ location_id: string }> = await m.query(
      `SELECT "location_id" FROM "stock_location" WHERE "car_id" = $1`,
      [asignacion.car_id],
    );
    const [carga]: Array<{ load_id: string }> = await m.query(
      `INSERT INTO "truck_load"
         ("distributor_id", "number", "car_id", "delivery_id", "origin_location_id", "business_date",
          "status", "opened_at", "departed_at", "returned_at", "closed_at", "opened_by_user_id",
          "closed_by_user_id", "difference_note", "notes")
       VALUES ($1, 1, $2, $3, $4, $5, 'closed_with_difference', $6, $6, $7, $7, $8, $8,
               'Se rompieron 2 garrafas en el reparto (seed)', 'Carga de ejemplo (seed)')
       RETURNING "load_id"`,
      [
        distributorId,
        asignacion.car_id,
        asignacion.delivery_id,
        deposito.location_id,
        diaArgentino(salioEl),
        salioEl,
        volvioEl,
        admin.user_id,
      ],
    );

    const base = {
      distributorId,
      referenceType: StockReferenceType.TRUCK_LOAD,
      referenceId: carga.load_id,
      actorUserId: admin.user_id,
    };
    // Las vacías con las que sale el camión estaban en el depósito (conteo del seed).
    await ledger.aplicar(m, {
      distributorId,
      referenceType: StockReferenceType.INITIAL,
      referenceId: null,
      actorUserId: null,
      vendible: 'sin-cambio',
      occurredAt: new Date(salioEl.getTime() - 60 * 60 * 1000),
      notes: 'Vacías para el canje del camión (seed)',
      movimientos: [
        {
          gasCylinderId: producto.gas_cylinder_id,
          quantity: 4,
          from: null,
          to: {
            locationId: deposito.location_id,
            condition: StockCondition.EMPTY,
          },
          reason: StockMovementReason.INITIAL_COUNT,
        },
      ],
    });
    await ledger.aplicar(m, {
      ...base,
      occurredAt: salioEl,
      notes: 'Salida del camión (carga N° 1)',
      movimientos: [
        [12, StockCondition.FULL],
        [4, StockCondition.EMPTY],
      ].map(([quantity, condition]) => ({
        gasCylinderId: producto.gas_cylinder_id,
        quantity: quantity as number,
        from: {
          locationId: deposito.location_id,
          condition: condition as StockCondition,
        },
        to: {
          locationId: camion.location_id,
          condition: condition as StockCondition,
        },
        reason: StockMovementReason.TRUCK_LOAD,
      })),
    });

    const esperado = esperadoDe({
      loadedFull: 12,
      reloadedFull: 0,
      deliveredFull: 0,
      loadedEmpty: 4,
      collectedEmpty: 0,
    });
    const plan = planDeCierre(camion.location_id, deposito.location_id, [
      {
        gasCylinderId: producto.gas_cylinder_id,
        ...esperado,
        declaredFull: 10,
        declaredEmpty: 4,
        balanceFull: 12,
        balanceEmpty: 4,
      },
    ]);
    await ledger.aplicar(m, {
      ...base,
      occurredAt: volvioEl,
      notes: 'Rendición del camión (carga N° 1)',
      movimientos: plan.movimientos,
    });
    const [{ differenceFull, differenceEmpty }] = plan.renglones;
    await m.query(
      `INSERT INTO "truck_load_item"
         ("load_id", "gas_cylinder_id", "loaded_full", "loaded_empty", "declared_return_full", "declared_return_empty",
          "delivered_full", "collected_empty", "expected_full", "expected_empty", "difference_full", "difference_empty")
       VALUES ($1, $2, 12, 4, 10, 4, 0, 0, $3, $4, $5, $6)`,
      [
        carga.load_id,
        producto.gas_cylinder_id,
        esperado.expectedFull,
        esperado.expectedEmpty,
        differenceFull,
        differenceEmpty,
      ],
    );
    await m.query(
      `INSERT INTO "document_sequence" ("distributor_id", "doc_type", "last_number") VALUES ($1, 'truck_load', 1)
       ON CONFLICT ("distributor_id", "doc_type") DO UPDATE SET "last_number" = 1`,
      [distributorId],
    );
    return 1;
  });
}
