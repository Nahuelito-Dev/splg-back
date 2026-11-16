import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { SupportSession } from './support-session.entity';

/**
 * Registro de lo que miró el soporte: una fila por request hecha en una sesión
 * (la escribe la etapa E2). Sólo se agrega: un trigger rechaza UPDATE y DELETE
 * (`sql/sesiones-de-soporte.ts`), y no entra en la auditoría por triggers
 * porque ya es un registro (`audit-exclusions.ts`).
 */
@Entity('support_access')
@Index('IDX_support_access_sesion', ['supportSessionId', 'at'])
@Index('IDX_support_access_distribuidora', ['distributorId', 'at'])
export class SupportAccess {
  @PrimaryGeneratedColumn('identity', {
    name: 'support_access_id',
    type: 'bigint',
    generatedIdentity: 'ALWAYS',
  })
  supportAccessId!: string;

  @ManyToOne(() => SupportSession, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'support_session_id' })
  session?: SupportSession;

  @Column({ name: 'support_session_id', type: 'uuid' })
  supportSessionId!: string;

  /** Desnormalizado de la sesión, para filtrar el historial de la empresa. */
  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  at!: Date;

  @Column({ name: 'http_method', type: 'varchar', length: 10 })
  httpMethod!: string;

  /** Patrón de la ruta (como `audit_log`): el dato concreto va en `resourceId`. */
  @Column({ type: 'varchar', length: 255 })
  path!: string;

  @Column({ type: 'varchar', length: 60, nullable: true })
  resource!: string | null;

  @Column({ name: 'resource_id', type: 'varchar', length: 64, nullable: true })
  resourceId!: string | null;

  /** Filtros depurados; los términos de búsqueda libre no se guardan en claro. */
  @Column({ type: 'jsonb', nullable: true })
  query!: Record<string, unknown> | null;

  @Column({ name: 'status_code', type: 'smallint' })
  statusCode!: number;

  /** Filas devueltas, si fue un listado. */
  @Column({ type: 'integer', nullable: true })
  items!: number | null;

  @Column({ type: 'boolean', default: false })
  masked!: boolean;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ip!: string | null;
}
