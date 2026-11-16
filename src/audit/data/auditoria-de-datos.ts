import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { AuditActionTypeId } from '../entities/audit-action-type.entity';
import { auditContext } from './audit-context';

/** Un campo que cambió, ya en texto. */
export interface CambioDeCampo {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

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
 * Escribe a mano una Auditoria y sus DetalleAuditoria con el `manager`
 * recibido, o sea dentro de la transacción del cambio. Los cambios de datos
 * los asientan los triggers de la base; esto queda sólo para lo que un trigger
 * no ve: un hecho que no es una columna (el motivo de una entrega manual, la
 * anulación de los datos de quien recibe, que no se auditan).
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
            "entity", "record_id", "ip", "source", "app_name")
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'app',
                 left(current_setting('application_name'), 63))
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
