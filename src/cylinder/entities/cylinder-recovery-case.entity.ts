import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
  Check,
} from 'typeorm';
import { Cylinder } from './cylinder.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';

export enum RecoveryCaseStatus {
  /** En marcha: el cliente recibe los avisos de su escalón. */
  OPEN = 'open',
  /** El envase volvió: el caso se cerró y el depósito quedó liberado. */
  RETURNED = 'returned',
  /** Agotados los escalones con un importe sobre el umbral: espera la decisión del administrador. */
  ESCALATED = 'escalated',
  DEPOSIT_CHARGED = 'deposit_charged',
  WRITTEN_OFF = 'written_off',
  CLOSED_NO_CHARGE = 'closed_no_charge',
  /** Agotados los escalones con un importe bajo el umbral: envase perdido, sólo se informa en el reporte. */
  LOST = 'lost',
}

/** Estados en los que el caso sigue vivo (no tiene cierre). */
export const ESTADOS_VIVOS_DEL_RECUPERO: readonly RecoveryCaseStatus[] = [
  RecoveryCaseStatus.OPEN,
  RecoveryCaseStatus.ESCALATED,
  RecoveryCaseStatus.LOST,
];

/** Estados en los que decide el administrador. */
export const ESTADOS_A_RESOLVER: readonly RecoveryCaseStatus[] = [
  RecoveryCaseStatus.ESCALATED,
  RecoveryCaseStatus.LOST,
];

/** Escalón en el que se agotó la secuencia: ya no hay más avisos. */
export const ESCALON_AGOTADO = 3;

/**
 * Caso de recupero
 * La gestión de un envase retenido por un cliente. Un envase tiene a lo sumo un
 * caso vivo; un cierre lleva fecha y, si lo decidió el administrador, su nota.
 * Casos: CU-108 (M5)
 */
@Check(
  'CHK_recovery_case_importe_y_escalon',
  `"deposit_amount" >= 0 AND "step" BETWEEN 1 AND 3`,
)
@Check(
  'CHK_recovery_case_estado',
  `(("status" IN ('open', 'escalated', 'lost')) = ("closed_at" IS NULL)) AND ("status" NOT IN ('escalated', 'lost') OR "exhausted_at" IS NOT NULL) AND ("status" NOT IN ('deposit_charged', 'written_off', 'closed_no_charge') OR ("resolution_note" IS NOT NULL AND char_length(btrim("resolution_note")) >= 10))`,
)
@Index('UQ_recovery_case_envase_vivo', ['cylinderId'], {
  unique: true,
  where: `"status" IN ('open', 'escalated', 'lost')`,
})
@Index('IDX_recovery_case_distribuidora_estado', ['distributorId', 'status'])
@Entity('cylinder_recovery_case')
export class CylinderRecoveryCase {
  @PrimaryGeneratedColumn('uuid', { name: 'case_id' })
  caseId!: string;

  @Index()
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor!: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Index()
  @ManyToOne(() => Cylinder, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cylinder_id' })
  cylinder!: Cylinder;

  @Column({ name: 'cylinder_id', type: 'uuid' })
  cylinderId!: string;

  @Index()
  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: false })
  deliveredAt!: Date;

  @Column({
    name: 'deposit_amount',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
    nullable: false,
  })
  depositAmount!: number;

  @Column({ name: 'step', type: 'integer', nullable: false, default: 1 })
  step!: number;

  @Column({
    name: 'status',
    type: 'enum',
    enum: RecoveryCaseStatus,
    enumName: 'recovery_case_status_enum',
    nullable: false,
    default: RecoveryCaseStatus.OPEN,
  })
  status!: RecoveryCaseStatus;

  /** Cuándo vence el escalón actual: pasada esta fecha el caso sube al siguiente. */
  @Column({
    name: 'step_due_at',
    type: 'timestamptz',
    nullable: false,
    default: () => 'now()',
  })
  stepDueAt!: Date;

  /** Cuándo se agotó la secuencia (escalado o perdido). */
  @Column({ name: 'exhausted_at', type: 'timestamptz', nullable: true })
  exhaustedAt!: Date | null;

  @CreateDateColumn({ name: 'opened_at', type: 'timestamptz' })
  openedAt!: Date;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'resolved_by_user_id' })
  resolvedByUser?: User;

  @Column({ name: 'resolved_by_user_id', type: 'uuid', nullable: true })
  resolvedByUserId!: string | null;

  @Column({ name: 'resolution_note', type: 'text', nullable: true })
  resolutionNote!: string | null;
}
