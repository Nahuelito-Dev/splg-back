import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';
import {
  SupportEndReason,
  SupportScope,
  SupportSessionKind,
  SupportSessionStatus,
} from '../domain/support-session.enums';

/**
 * Sesión de soporte del administrador general sobre una empresa (modo soporte,
 * `splg-docs/sistema/DISENO-SUPERADMIN-Y-MODO-SOPORTE.md` §4.3). Su ciclo
 * (pedido, aprobación, rechazo, revocación, vencimiento) lo asienta el trigger
 * de auditoría; los estados cambian sólo por la máquina del dominio
 * (`support-session.machine.ts`).
 *
 * Únicos parciales que crea la migración (`sql/sesiones-de-soporte.ts`;
 * `synchronize: false` para que TypeORM no quiera borrarlos): una sola sesión
 * activa por administrador general y una sola pendiente por administrador y
 * empresa.
 */
@Entity('support_session')
@Index('UQ_support_session_activa', { synchronize: false })
@Index('UQ_support_session_pendiente', { synchronize: false })
@Index('IDX_support_session_historial', ['distributorId', 'createdAt'])
@Check(
  'CHK_support_session_motivo',
  `char_length(btrim("reason")) BETWEEN 20 AND 1000`,
)
@Check(
  'CHK_support_session_alcance',
  `"scope" <@ ARRAY['personal_data','files','exports']::text[]`,
)
@Check(
  'CHK_support_session_minutos',
  `"requested_minutes" IN (15, 30, 60, 120)`,
)
@Check(
  'CHK_support_session_pendiente',
  `"status" <> 'pending' OR "request_expires_at" IS NOT NULL`,
)
@Check(
  'CHK_support_session_activa',
  `"status" NOT IN ('active', 'ended', 'revoked', 'expired') OR ("started_at" IS NOT NULL AND "expires_at" IS NOT NULL)`,
)
@Check(
  'CHK_support_session_duracion',
  `"started_at" IS NULL OR "expires_at" IS NULL OR ("expires_at" > "started_at" AND "expires_at" - "started_at" <= interval '120 minutes' AND ("kind" <> 'emergency' OR "expires_at" - "started_at" <= interval '60 minutes'))`,
)
@Check(
  'CHK_support_session_emergencia',
  `"kind" <> 'emergency' OR "decided_by" IS NULL`,
)
@Check(
  'CHK_support_session_fin',
  `("status" IN ('ended', 'revoked', 'expired')) = ("ended_at" IS NOT NULL AND "end_reason" IS NOT NULL)`,
)
@Check(
  'CHK_support_session_motivo_de_fin',
  `"end_reason" IS NULL OR "end_reason" IN ('exit', 'revoked_by_company', 'revoked_by_platform', 'expired')`,
)
export class SupportSession {
  @PrimaryGeneratedColumn('uuid', { name: 'support_session_id' })
  supportSessionId!: string;

  // RESTRICT: la baja de una empresa es lógica; su historial de soporte queda.
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'requested_by' })
  requester?: User;

  /** El administrador general que pidió (lo valida el back: la base no conoce roles). */
  @Column({ name: 'requested_by', type: 'uuid' })
  requestedBy!: string;

  @Column({
    type: 'enum',
    enum: SupportSessionKind,
    enumName: 'support_session_kind',
  })
  kind!: SupportSessionKind;

  @Column({
    type: 'enum',
    enum: SupportSessionStatus,
    enumName: 'support_session_status',
  })
  status!: SupportSessionStatus;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ name: 'ticket_ref', type: 'varchar', length: 60, nullable: true })
  ticketRef!: string | null;

  @Column({ type: 'text', array: true, default: '{}' })
  scope!: SupportScope[];

  @Column({ name: 'requested_minutes', type: 'smallint' })
  requestedMinutes!: number;

  /** Hasta cuándo la empresa puede responder una pendiente (24 h). */
  @Column({ name: 'request_expires_at', type: 'timestamptz', nullable: true })
  requestExpiresAt!: Date | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'decided_by' })
  decider?: User | null;

  /** Admin de la empresa que aprobó o rechazó; null en emergencia y autoaprobación. */
  @Column({ name: 'decided_by', type: 'uuid', nullable: true })
  decidedBy!: string | null;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  @Column({
    name: 'decision_note',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  decisionNote!: string | null;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  endedAt!: Date | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'ended_by' })
  ender?: User | null;

  /** Quién la cortó; null si venció o la cerró el sistema. */
  @Column({ name: 'ended_by', type: 'uuid', nullable: true })
  endedBy!: string | null;

  @Column({ name: 'end_reason', type: 'varchar', length: 30, nullable: true })
  endReason!: SupportEndReason | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
