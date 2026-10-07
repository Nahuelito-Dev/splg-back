import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { AuditActionTypeId } from '../entities/audit-action-type.entity';
import { auditContext } from './audit-context';
import { CambioDeCampo } from './audit-value';

export interface NuevaAuditoria {
  actionTypeId: AuditActionTypeId;
  /** Nombre de la entidad de dominio (`Order`, `Car`...). */
  entity: string;
  recordId: string;
  /** Si no se pasa, la del request en curso. */
  distributorId?: string | null;
  details: CambioDeCampo[];
}

/**
 * Escribe una Auditoria y sus DetalleAuditoria con el `manager` recibido, o
 * sea dentro de la transacción del cambio: si ésta se deshace, la auditoría
 * también. La usa el subscriber global y, a mano, las escrituras que TypeORM
 * no anuncia (`update()`, `softDelete()` y los query builders).
 *
 * Una sola sentencia (CTE) para el encabezado y todos los detalles.
 */
export class AuditoriaDeDatos {
  static async registrar(
    manager: EntityManager,
    auditoria: NuevaAuditoria,
  ): Promise<void> {
    const contexto = auditContext.getStore();
    const distributorId =
      auditoria.distributorId !== undefined
        ? auditoria.distributorId
        : (contexto?.distributorId ?? null);
    const auditId = randomUUID();
    const detalles = auditoria.details.map((d) => ({
      field: d.field.slice(0, 80),
      old_value: d.oldValue,
      new_value: d.newValue,
    }));
    await manager.query(
      `WITH cabecera AS (
         INSERT INTO "audit"
           ("audit_id", "action_type_id", "user_id", "distributor_id",
            "entity", "record_id", "ip")
         VALUES ($1, $2, $3, $4, $5, $6, $7)
       )
       INSERT INTO "audit_detail"
         ("audit_detail_id", "audit_id", "field", "old_value", "new_value")
       SELECT gen_random_uuid(), $1, d.field, d.old_value, d.new_value
       FROM jsonb_to_recordset($8::jsonb)
         AS d(field text, old_value text, new_value text)`,
      [
        auditId,
        auditoria.actionTypeId,
        contexto?.userId ?? null,
        distributorId,
        auditoria.entity.slice(0, 60),
        auditoria.recordId.slice(0, 64),
        contexto?.ip ?? null,
        JSON.stringify(detalles),
      ],
    );
  }
}
