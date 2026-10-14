/**
 * Purga completa de los datos de una o más distribuidoras para los seeds
 * (herramienta de desarrollo; el guardia `resguardoDeProduccion` la frena antes
 * de llegar acá).
 *
 * Borra de la hoja hacia la raíz, TODO en una transacción: si algo falla no
 * queda nada a medias. Lo que cuelga de la distribuidora sin tener
 * `distributor_id` propio (renglones de pedido, promociones, avisos de
 * recupero...) se borra por la tabla de la que cuelga.
 *
 * Tres tablas son de sólo escritura para la aplicación (un trigger rechaza
 * UPDATE y DELETE): `stock_movement`, `audit_log` y `audit`/`audit_detail`. La
 * purga del seed sí las vacía, porque reconstruye la demo desde cero; para eso
 * desactiva esos triggers dentro de SU transacción y los reactiva antes de
 * confirmar (el DDL de Postgres es transaccional: si algo falla, el rollback los
 * deja como estaban). Esto NO existe en la aplicación: sólo en los seeds.
 */
import { EntityManager } from 'typeorm';
import { limpiarCompras } from './purchase-demo';
import { limpiarCargas } from './truck-load-demo';

const TRIGGERS_DE_SOLO_ESCRITURA: ReadonlyArray<
  [tabla: string, trigger: string]
> = [
  ['stock_movement', 'stock_movement_inmutable'],
  ['audit_log', 'audit_log_inmutable'],
  ['audit', 'audit_inmutable'],
  ['audit_detail', 'audit_detail_inmutable'],
];

/** Tablas con `distributor_id` que se vacían, en orden (cada una ya sin hijos). */
const TABLAS_POR_DISTRIBUIDORA: readonly string[] = [
  'maintenance_task_attachment',
  'attachment',
  'vehicle_usage_log',
  'vehicle_assignment',
  'stock_adjustment',
  'stock_threshold',
  'stock_reconciliation_alert',
  'stock_movement',
  'stock_balance',
  'stock_location',
  'warehouse',
  'repurchase_invitation',
  'cylinder_inspection',
  'cylinder_movement',
  'order_dispatch_offer',
  'rating',
  'incident',
  'claims',
  'payment',
];

export interface ResumenDePurga {
  distribuidoras: number;
  usuariosBorrados: number;
  usuariosArchivados: number;
}

/**
 * Vacía los datos de `distributorIds` sin tocar a los usuarios con login (los
 * que tienen `firebase_uid`). Con `borrarDistribuidoras` también quita la fila de
 * la distribuidora y su staff (para las que ya no deben existir).
 */
export async function purgarDistribuidoras(
  m: EntityManager,
  distributorIds: string[],
  opciones: {
    borrarDistribuidoras?: boolean;
    /**
     * `false`: la auditoría sin distribuidora (altas de personas, clientes y
     * direcciones) NO se toca; sólo se borra la de las distribuidoras indicadas.
     */
    auditoriaGlobal?: boolean;
  } = {},
): Promise<void> {
  if (distributorIds.length === 0) return;
  const ids = [distributorIds];
  const q = (sql: string) => m.query(sql, ids);

  for (const [tabla, trigger] of TRIGGERS_DE_SOLO_ESCRITURA) {
    await m.query(`ALTER TABLE "${tabla}" DISABLE TRIGGER "${trigger}"`);
  }

  // Auditoría: lo de la distribuidora y, en modo global, lo que no pertenece a
  // ninguna (altas de personas, clientes, direcciones), que de otro modo
  // apuntaría a usuarios que se borran más abajo.
  const global = opciones.auditoriaGlobal !== false;
  const delAlcance = global
    ? `"distributor_id" = ANY($1::uuid[]) OR "distributor_id" IS NULL`
    : `"distributor_id" = ANY($1::uuid[])`;
  await q(
    `DELETE FROM "audit_detail" WHERE "audit_id" IN (SELECT "audit_id" FROM "audit" WHERE ${delAlcance})`,
  );
  await q(`DELETE FROM "audit" WHERE ${delAlcance}`);
  await q(`DELETE FROM "audit_log" WHERE ${delAlcance}`);

  // Mantenimiento.
  await q(
    `DELETE FROM "maintenance_window_proposal" WHERE "task_id" IN
       (SELECT "task_id" FROM "maintenance_task" WHERE "distributor_id" = ANY($1::uuid[]))`,
  );
  await q(
    `DELETE FROM "maintenance_task_attachment" WHERE "distributor_id" = ANY($1::uuid[])`,
  );
  await q(
    `DELETE FROM "maintenance_task" WHERE "distributor_id" = ANY($1::uuid[])`,
  );
  await q(
    `DELETE FROM "maintenance_plan" WHERE "distributor_id" = ANY($1::uuid[])`,
  );

  // Rutas de reparto.
  await q(
    `DELETE FROM "route_batch_offer" WHERE "batch_id" IN
       (SELECT "batch_id" FROM "route_batch" WHERE "distributor_id" = ANY($1::uuid[]))`,
  );
  await q(
    `DELETE FROM "route_batch_stop" WHERE "batch_id" IN
       (SELECT "batch_id" FROM "route_batch" WHERE "distributor_id" = ANY($1::uuid[]))`,
  );
  await q(`DELETE FROM "route_batch" WHERE "distributor_id" = ANY($1::uuid[])`);

  // Recupero de envases.
  await q(
    `DELETE FROM "cylinder_recovery_notice" WHERE "case_id" IN
       (SELECT "case_id" FROM "cylinder_recovery_case" WHERE "distributor_id" = ANY($1::uuid[]))`,
  );
  await q(
    `DELETE FROM "cylinder_recovery_case" WHERE "distributor_id" = ANY($1::uuid[])`,
  );

  // Cargas, compras, ajustes y stock (en este orden: cuelgan unos de otros).
  await limpiarCargas(m, distributorIds);
  await limpiarCompras(m, distributorIds);
  await q(
    `DELETE FROM "stock_adjustment_item" WHERE "adjustment_id" IN
       (SELECT "adjustment_id" FROM "stock_adjustment" WHERE "distributor_id" = ANY($1::uuid[]))`,
  );

  // Carritos.
  await q(
    `DELETE FROM "cart_item" WHERE "cart_id" IN
       (SELECT "cart_id" FROM "cart" WHERE "distributor_id" = ANY($1::uuid[]))`,
  );
  await q(`DELETE FROM "cart" WHERE "distributor_id" = ANY($1::uuid[])`);

  // Pedidos y todo lo que cuelga de ellos.
  const delPedido = `(SELECT "order_id" FROM "order" WHERE "distributor_id" = ANY($1::uuid[]))`;
  for (const tabla of [
    'order_status_history',
    'order_address_change',
    'route_batch_stop',
    'order_item',
  ]) {
    await q(`DELETE FROM "${tabla}" WHERE "order_id" IN ${delPedido}`);
  }
  for (const tabla of TABLAS_POR_DISTRIBUIDORA) {
    await q(`DELETE FROM "${tabla}" WHERE "distributor_id" = ANY($1::uuid[])`);
  }
  await q(`DELETE FROM "cylinder" WHERE "distributor_id" = ANY($1::uuid[])`);
  await q(`DELETE FROM "order" WHERE "distributor_id" = ANY($1::uuid[])`);

  // Personal (después de las cargas, que pueden tener ayudante).
  await q(`DELETE FROM "employee" WHERE "distributor_id" = ANY($1::uuid[])`);
  await q(
    `DELETE FROM "job_position" WHERE "distributor_id" = ANY($1::uuid[])`,
  );

  // Catálogo y operación.
  await q(`DELETE FROM "time_slot" WHERE "distributor_id" = ANY($1::uuid[])`);
  await q(
    `DELETE FROM "coverage_zone" WHERE "distributor_id" = ANY($1::uuid[])`,
  );
  await q(
    `DELETE FROM "gas_cylinder_promotion" WHERE "gas_cylinder_id" IN
       (SELECT "gas_cylinder_id" FROM "gas_cylinder" WHERE "distributor_id" = ANY($1::uuid[]))`,
  );
  await q(
    `UPDATE "customer" SET "declared_cylinder_type_id" = NULL WHERE "declared_cylinder_type_id" IN
       (SELECT "gas_cylinder_id" FROM "gas_cylinder" WHERE "distributor_id" = ANY($1::uuid[]))`,
  );
  await q(
    `DELETE FROM "gas_cylinder" WHERE "distributor_id" = ANY($1::uuid[])`,
  );
  await q(`DELETE FROM "car" WHERE "distributor_id" = ANY($1::uuid[])`);
  await q(
    `DELETE FROM "document_sequence" WHERE "distributor_id" = ANY($1::uuid[])`,
  );

  if (opciones.borrarDistribuidoras) {
    await q(`DELETE FROM "delivery" WHERE "distributor_id" = ANY($1::uuid[])`);
    await q(`DELETE FROM "admin" WHERE "distributor_id" = ANY($1::uuid[])`);
    await q(
      `DELETE FROM "module_config" WHERE "distributor_id" = ANY($1::uuid[])`,
    );
    await q(
      `DELETE FROM "distributor" WHERE "distributor_id" = ANY($1::uuid[])`,
    );
  }

  for (const [tabla, trigger] of TRIGGERS_DE_SOLO_ESCRITURA) {
    await m.query(`ALTER TABLE "${tabla}" ENABLE TRIGGER "${trigger}"`);
  }
}

const VINCULOS = (alias: string) => `
  SELECT 1 FROM "order" o WHERE o."customer_id" = ${alias}."user_id"
  UNION ALL SELECT 1 FROM "delivery" d WHERE d."user_id" = ${alias}."user_id"
  UNION ALL SELECT 1 FROM "admin" a WHERE a."user_id" = ${alias}."user_id" 
  UNION ALL SELECT 1 FROM "employee" e WHERE e."user_id" = ${alias}."user_id"
  UNION ALL SELECT 1 FROM "car" c WHERE c."user_id" = ${alias}."user_id"`;

/**
 * Las personas sin login que se quitan: las ligadas a las distribuidoras `ids`
 * (por pedidos, o por perfil de chofer, administrador, legajo o vehículo con su
 * `distributor_id`) y a NINGUNA otra, más las que se acaban de dar de baja
 * (`extras`). Se calcula ANTES de la purga (después ya no hay vínculos).
 */
export async function personasSinLoginDeAlcance(
  m: EntityManager,
  ids: string[],
  extras: string[] = [],
): Promise<string[]> {
  const filas: Array<{ user_id: string }> = await m.query(
    `SELECT u."user_id" FROM "user" u
      WHERE u."user_id" = ANY($2::uuid[])
         OR (
           u."firebase_uid" IS NULL
           AND (
             EXISTS (SELECT 1 FROM "order" o WHERE o."customer_id" = u."user_id" AND o."distributor_id" = ANY($1::uuid[]))
             OR EXISTS (SELECT 1 FROM "delivery" d WHERE d."user_id" = u."user_id" AND d."distributor_id" = ANY($1::uuid[]))
             OR EXISTS (SELECT 1 FROM "admin" a WHERE a."user_id" = u."user_id" AND a."distributor_id" = ANY($1::uuid[]))
             OR EXISTS (SELECT 1 FROM "employee" e WHERE e."user_id" = u."user_id" AND e."distributor_id" = ANY($1::uuid[]))
             OR EXISTS (SELECT 1 FROM "car" c WHERE c."user_id" = u."user_id" AND c."distributor_id" = ANY($1::uuid[]))
           )
           AND NOT EXISTS (SELECT 1 FROM "order" o WHERE o."customer_id" = u."user_id" AND NOT (o."distributor_id" = ANY($1::uuid[])))
           AND NOT EXISTS (SELECT 1 FROM "delivery" d WHERE d."user_id" = u."user_id" AND NOT (d."distributor_id" = ANY($1::uuid[])))
           -- un admin global (sin distribuidora) cuenta como vínculo fuera de la demo
           AND NOT EXISTS (SELECT 1 FROM "admin" a WHERE a."user_id" = u."user_id" AND (a."distributor_id" IS NULL OR NOT (a."distributor_id" = ANY($1::uuid[]))))
           AND NOT EXISTS (SELECT 1 FROM "employee" e WHERE e."user_id" = u."user_id" AND NOT (e."distributor_id" = ANY($1::uuid[])))
           AND NOT EXISTS (SELECT 1 FROM "car" c WHERE c."user_id" = u."user_id" AND NOT (c."distributor_id" = ANY($1::uuid[])))
         )`,
    [ids, extras],
  );
  return filas.map((f) => f.user_id);
}

export interface HuerfanoSinLogin {
  user_id: string;
  email: string | null;
  full_name: string | null;
}

/**
 * Usuarios sin login ni perfil ni pedidos en NINGUNA distribuidora: no se sabe de
 * quién son, así que el seed los lista y no los toca salvo confirmación aparte.
 */
export async function huerfanosSinLogin(
  m: EntityManager,
  excluir: string[] = [],
): Promise<HuerfanoSinLogin[]> {
  return m.query(
    `SELECT u."user_id", u."email", u."full_name" FROM "user" u
      WHERE u."firebase_uid" IS NULL AND u."deletedAt" IS NULL
        AND NOT (u."user_id" = ANY($1::uuid[]))
        AND NOT EXISTS (${VINCULOS('u')})
      ORDER BY u."email"`,
    [excluir],
  );
}

/**
 * Quita a `alcance` (personas sin cuenta en Firebase: clientes y choferes de
 * demostración y cuentas dadas de baja). Las direcciones sin pedidos que se borran
 * son las de esas personas y las de `direccionesExtra` (por ejemplo el cliente con
 * login de la demo): nunca las de otras cuentas. Si a alguna persona la referencia
 * algo que la purga no conoce, no se borra: queda archivada y se informa.
 */
export async function purgarPersonasSinLogin(
  m: EntityManager,
  alcance: string[],
  direccionesExtra: string[] = [],
  distribuidoras: string[] = [],
): Promise<ResumenDePurga> {
  const resumen: ResumenDePurga = {
    distribuidoras: 0,
    usuariosBorrados: 0,
    usuariosArchivados: 0,
  };
  if (alcance.length === 0 && direccionesExtra.length === 0) return resumen;
  const quienes = `(SELECT "user_id" FROM "user" WHERE "user_id" = ANY($1::uuid[]))`;
  const params = [alcance];
  await m.query(
    `DELETE FROM "delivery" d WHERE d."user_id" IN ${quienes}
       AND d."distributor_id" = ANY($2::uuid[])
       AND NOT EXISTS (SELECT 1 FROM "order" o WHERE o."delivery_id" = d."delivery_id")`,
    [alcance, distribuidoras],
  );
  await m.query(
    `DELETE FROM "user_address" a
      WHERE (a."user_id" = ANY($1::uuid[]) OR a."user_id" = ANY($2::uuid[]))
        AND NOT EXISTS (SELECT 1 FROM "order" o WHERE o."address_id" = a."address_id")`,
    [alcance, direccionesExtra],
  );
  await m.query(
    `UPDATE "module_config" SET "updated_by_user_id" = NULL WHERE "updated_by_user_id" IN ${quienes}`,
    params,
  );
  // Lo que esas personas firmaron en auditoría (FK al usuario).
  const triggers = TRIGGERS_DE_SOLO_ESCRITURA.filter(
    ([t]) => t !== 'stock_movement',
  );
  for (const [tabla, trigger] of triggers) {
    await m.query(`ALTER TABLE "${tabla}" DISABLE TRIGGER "${trigger}"`);
  }
  await m.query(
    `DELETE FROM "audit_detail" WHERE "audit_id" IN (SELECT "audit_id" FROM "audit" WHERE "user_id" IN ${quienes})`,
    params,
  );
  await m.query(`DELETE FROM "audit" WHERE "user_id" IN ${quienes}`, params);
  await m.query(
    `DELETE FROM "audit_log" WHERE "actor_user_id" IN ${quienes}`,
    params,
  );
  for (const [tabla, trigger] of triggers) {
    await m.query(`ALTER TABLE "${tabla}" ENABLE TRIGGER "${trigger}"`);
  }
  for (const user_id of alcance) {
    await m.query('SAVEPOINT borrar_usuario');
    try {
      await m.query(`DELETE FROM "customer" WHERE "user_id" = $1`, [user_id]);
      await m.query(
        `DELETE FROM "admin" WHERE "user_id" = $1 AND "distributor_id" = ANY($2::uuid[])`,
        [user_id, distribuidoras],
      );
      await m.query(`DELETE FROM "user" WHERE "user_id" = $1`, [user_id]);
      await m.query('RELEASE SAVEPOINT borrar_usuario');
      resumen.usuariosBorrados += 1;
    } catch {
      await m.query('ROLLBACK TO SAVEPOINT borrar_usuario');
      await m.query(
        `UPDATE "user" SET "deletedAt" = COALESCE("deletedAt", now()) WHERE "user_id" = $1`,
        [user_id],
      );
      resumen.usuariosArchivados += 1;
    }
  }
  return resumen;
}
