/**
 * Auditoría de la demo (herramienta de desarrollo): deja en `audit`/`audit_detail`
 * y en `audit_log` el rastro que habría dejado el uso real de lo que se sembró,
 * con las mismas fechas que los documentos. La purga del seed los vacía antes.
 */
import { EntityManager } from 'typeorm';

export interface EventoDeAuditoria {
  entidad: string;
  recordId: string;
  /** 1 Alta, 2 Modificación. */
  accion: 1 | 2;
  cuando: Date;
  /** Campo, valor anterior, valor nuevo. */
  campos: Array<[campo: string, anterior: string | null, nuevo: string | null]>;
  usuarioId?: string | null;
}

const RECURSO_POR_ENTIDAD: Record<string, string> = {
  PurchaseOrder: 'purchase-orders',
  PurchaseReceipt: 'purchase-receipts',
  StockAdjustment: 'stock/adjustments',
  TruckLoad: 'truck-loads',
  Warehouse: 'warehouses',
  Car: 'fleet/vehicles',
  Employee: 'employees',
  GasCylinder: 'gascylinder',
  Claims: 'claims',
  Supplier: 'suppliers',
};

const IP_DEL_PANEL = '186.13.84.27';

export async function sembrarAuditoria(
  m: EntityManager,
  args: {
    distributorId: string;
    adminUserId: string;
    eventos: EventoDeAuditoria[];
  },
): Promise<{ audit: number; detalles: number; bitacora: number }> {
  const { distributorId, adminUserId } = args;
  let detalles = 0;
  let bitacora = 0;
  const eventos = [...args.eventos].sort(
    (a, b) => a.cuando.getTime() - b.cuando.getTime(),
  );
  for (const e of eventos) {
    const usuario = e.usuarioId === undefined ? adminUserId : e.usuarioId;
    const [a]: Array<{ audit_id: string }> = await m.query(
      `INSERT INTO "audit" ("action_type_id", "user_id", "distributor_id", "entity", "record_id", "ip", "created_at")
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING "audit_id"`,
      [
        e.accion,
        usuario,
        distributorId,
        e.entidad,
        e.recordId,
        IP_DEL_PANEL,
        e.cuando,
      ],
    );
    for (const [campo, anterior, nuevo] of e.campos) {
      await m.query(
        `INSERT INTO "audit_detail" ("audit_id", "field", "old_value", "new_value") VALUES ($1, $2, $3, $4)`,
        [a.audit_id, campo, anterior, nuevo],
      );
      detalles += 1;
    }
    const recurso = RECURSO_POR_ENTIDAD[e.entidad];
    if (recurso && usuario) {
      await m.query(
        `INSERT INTO "audit_log"
           ("distributor_id", "actor_user_id", "actor_role", "http_method", "resource", "resource_id", "path",
            "client_source", "ip", "result", "status_code", "changes", "created_at")
         VALUES ($1, $2, 'admin', $3, $4, $5, $6, 'admin-panel', $7, 'success', $8, $9::jsonb, $10)`,
        [
          distributorId,
          usuario,
          e.accion === 1 ? 'POST' : 'PATCH',
          recurso,
          e.recordId,
          e.accion === 1 ? `/${recurso}` : `/${recurso}/:id`,
          IP_DEL_PANEL,
          e.accion === 1 ? 201 : 200,
          JSON.stringify(
            Object.fromEntries(
              e.campos
                .filter(([, , n]) => n !== null)
                .map(([c, , n]) => [c, n]),
            ),
          ),
          e.cuando,
        ],
      );
      bitacora += 1;
    }
  }

  // Dos intentos rechazados, como pasa en el uso real.
  const rechazos: Array<[string, string, number, string, number]> = [
    [
      'POST',
      'stock/adjustments',
      400,
      'No hay stock suficiente para el ajuste pedido',
      30,
    ],
    [
      'POST',
      'purchase-receipts',
      409,
      'La orden de compra ya fue recibida por completo',
      12,
    ],
  ];
  for (const [metodo, recurso, estado, mensaje, dias] of rechazos) {
    await m.query(
      `INSERT INTO "audit_log"
         ("distributor_id", "actor_user_id", "actor_role", "http_method", "resource", "path", "client_source", "ip",
          "result", "status_code", "error_message", "created_at")
       VALUES ($1, $2, 'admin', $3, $4, $5, 'admin-panel', $6, 'failure', $7, $8, $9)`,
      [
        distributorId,
        adminUserId,
        metodo,
        recurso,
        `/${recurso}`,
        IP_DEL_PANEL,
        estado,
        mensaje,
        new Date(Date.now() - dias * 24 * 60 * 60 * 1000),
      ],
    );
    bitacora += 1;
  }
  return { audit: eventos.length, detalles, bitacora };
}
