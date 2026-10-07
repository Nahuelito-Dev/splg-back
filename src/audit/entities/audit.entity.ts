import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';
import { AuditActionType } from './audit-action-type.entity';
import { AuditDetail } from './audit-detail.entity';

/**
 * Auditoria del modelo de la cátedra: una fila por registro de una entidad de
 * negocio que se dio de alta, se modificó, se dio de baja o se reactivó. Es de
 * sólo escritura (trigger en la base). A diferencia de `audit_log`, que es la
 * bitácora de requests HTTP, éste registra el dato: qué registro y qué campos
 * cambiaron (`audit_detail`).
 */
@Entity('audit')
@Index('IDX_audit_entity_record', ['entity', 'recordId'])
@Index('IDX_audit_distributor_created_at', ['distributorId', 'createdAt'])
export class Audit {
  @PrimaryGeneratedColumn('uuid', { name: 'audit_id' })
  auditId!: string;

  @Column({ name: 'action_type_id', type: 'smallint' })
  actionTypeId!: number;

  @ManyToOne(() => AuditActionType, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'action_type_id' })
  actionType?: AuditActionType;

  /** Quién lo hizo; null si fue el sistema (cron, seed, webhook sin usuario). */
  @Index('IDX_audit_user')
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user?: User | null;

  /** Distribuidora (tenant) del registro, para acotar la consulta. */
  @Column({ name: 'distributor_id', type: 'uuid', nullable: true })
  distributorId!: string | null;

  @ManyToOne(() => Distributor, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor | null;

  /** Nombre de la entidad de dominio (`Order`, `Employee`...), no la URL. */
  @Column({ type: 'varchar', length: 60 })
  entity!: string;

  /** Id del registro afectado; en una clave compuesta, las partes con ':'. */
  @Column({ name: 'record_id', type: 'varchar', length: 64 })
  recordId!: string;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ip!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @OneToMany(() => AuditDetail, (d) => d.audit)
  details?: AuditDetail[];
}
