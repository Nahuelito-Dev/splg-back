import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';

/** Si la operación registrada terminó bien o fue rechazada. */
export enum AuditResult {
  SUCCESS = 'success',
  FAILURE = 'failure',
}

/** Lo que cambió en una operación, con las credenciales ya depuradas. */
export type CambiosAuditados = Record<string, unknown>;

/**
 * Un asiento de auditoría: una fila por operación de escritura, exitosa o
 * fallida (CU-153). Es de sólo escritura: ningún rol lo modifica ni lo borra.
 * Si se borra el autor o la distribuidora, la referencia queda vacía pero el
 * asiento se conserva. Índices por fecha, autor y distribuidora para la
 * consulta (CU-152).
 */
@Entity('audit_log')
@Index('IDX_audit_log_created_at', ['createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid', { name: 'audit_id' })
  auditId!: string;

  @Index('IDX_audit_log_distributor')
  @Column({ name: 'distributor_id', type: 'uuid', nullable: true })
  distributorId!: string | null;

  @ManyToOne(() => Distributor, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor | null;

  @Index('IDX_audit_log_actor')
  @Column({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'actor_user_id' })
  actor?: User | null;

  /** Rol con que operó. */
  @Column({ name: 'actor_role', type: 'varchar', length: 30, nullable: true })
  actorRole!: string | null;

  /** POST, PUT, PATCH o DELETE. */
  @Column({ name: 'http_method', type: 'varchar', length: 10 })
  httpMethod!: string;

  /** Tipo de recurso afectado (el primer segmento de la ruta). */
  @Column({ type: 'varchar', length: 60 })
  resource!: string;

  @Column({ name: 'resource_id', type: 'varchar', length: 64, nullable: true })
  resourceId!: string | null;

  @Column({ type: 'varchar', length: 255 })
  path!: string;

  /** Panel, app de cliente o app de chofer (header X-Client-Source). */
  @Column({
    name: 'client_source',
    type: 'varchar',
    length: 30,
    nullable: true,
  })
  clientSource!: string | null;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ip!: string | null;

  @Column({ type: 'enum', enum: AuditResult, enumName: 'audit_result_enum' })
  result!: AuditResult;

  @Column({ name: 'status_code', type: 'int' })
  statusCode!: number;

  @Column({ type: 'jsonb', nullable: true })
  changes!: CambiosAuditados | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
