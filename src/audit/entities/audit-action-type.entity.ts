import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Ids fijos del catálogo: la migración los siembra y el código los usa. */
export enum AuditActionTypeId {
  CREATE = 1,
  UPDATE = 2,
  SOFT_DELETE = 3,
  RESTORE = 4,
  PHYSICAL_DELETE = 5,
  LOGIN = 6,
  LOGIN_FAILED = 7,
  LOGOUT = 8,
}

/** Nombre de cada acción tal como se siembra en el catálogo. */
export const AUDIT_ACTION_TYPE_NAMES: Record<AuditActionTypeId, string> = {
  [AuditActionTypeId.CREATE]: 'Alta',
  [AuditActionTypeId.UPDATE]: 'Modificación',
  [AuditActionTypeId.SOFT_DELETE]: 'Baja lógica',
  [AuditActionTypeId.RESTORE]: 'Reactivación',
  [AuditActionTypeId.PHYSICAL_DELETE]: 'Baja física',
  [AuditActionTypeId.LOGIN]: 'Ingreso',
  [AuditActionTypeId.LOGIN_FAILED]: 'Ingreso fallido',
  [AuditActionTypeId.LOGOUT]: 'Salida',
};

/**
 * TipoAccionAuditoria del modelo de la cátedra: el catálogo de acciones que
 * se auditan. Es fijo (lo siembra la migración), la API sólo lo lee.
 */
@Entity('audit_action_type')
export class AuditActionType {
  @PrimaryColumn({ name: 'action_type_id', type: 'smallint' })
  actionTypeId!: number;

  @Column({ type: 'varchar', length: 40, unique: true })
  name!: string;
}
