import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  Check,
  Unique,
} from 'typeorm';
import { MaintenanceTask } from './maintenance-task.entity';
import { MaintenancePlanningCase } from './maintenance-planning-case.entity';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';

export enum WindowProposalStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  REJECTED = 'rejected',
  EXPIRED = 'expired',
  /** El caso se re-planificó o lo resolvió el administrador: la propuesta ya no corre. */
  CANCELLED = 'cancelled',
}

/**
 * Propuesta de ventana de taller
 * Una ventana ofrecida al chofer, de a una por vez, con vigencia.
 * Casos: CU-136 a CU-142 y CU-105 (M2)
 */
@Check(
  'CHK_window_proposal_ventana',
  `"window_end" > "window_start" AND "rank" >= 1`,
)
@Check(
  'CHK_window_proposal_respuesta',
  `("status" IN ('accepted', 'rejected')) = ("responded_at" IS NOT NULL) AND ("status" <> 'rejected' OR "rejection_reason" IS NOT NULL)`,
)
@Check(
  'CHK_window_proposal_alternativa',
  `("alt_window_start" IS NULL) = ("alt_window_end" IS NULL) AND ("alt_window_start" IS NULL OR ("status" = 'rejected' AND "alt_window_end" > "alt_window_start"))`,
)
@Unique('UQ_window_proposal_caso_orden', ['caseId', 'rank'])
@Index('UQ_window_proposal_caso_pendiente', ['caseId'], {
  unique: true,
  where: `"status" = 'pending'`,
})
@Entity('maintenance_window_proposal')
export class MaintenanceWindowProposal {
  @PrimaryGeneratedColumn('uuid', { name: 'proposal_id' })
  proposalId!: string;

  @ManyToOne(() => MaintenanceTask, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'task_id' })
  task!: MaintenanceTask;

  @Column({ name: 'task_id', type: 'uuid' })
  taskId!: string;

  @ManyToOne(() => MaintenancePlanningCase, (c) => c.proposals, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'case_id' })
  planningCase!: MaintenancePlanningCase;

  @Index('IDX_window_proposal_caso')
  @Column({ name: 'case_id', type: 'uuid' })
  caseId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor!: Distributor;

  @Index('IDX_window_proposal_distribuidora')
  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @ManyToOne(() => Delivery, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'delivery_id' })
  delivery!: Delivery;

  @Column({ name: 'delivery_id', type: 'uuid' })
  deliveryId!: string;

  @Column({ name: 'window_start', type: 'timestamptz', nullable: false })
  windowStart!: Date;

  @Column({ name: 'window_end', type: 'timestamptz', nullable: false })
  windowEnd!: Date;

  @Column({ name: 'rank', type: 'integer', nullable: false })
  rank!: number;

  @Column({
    name: 'status',
    type: 'enum',
    enum: WindowProposalStatus,
    enumName: 'window_proposal_status_enum',
    nullable: false,
    default: WindowProposalStatus.PENDING,
  })
  status!: WindowProposalStatus;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: false })
  expiresAt!: Date;

  @Column({ name: 'responded_at', type: 'timestamptz', nullable: true })
  respondedAt!: Date | null;

  /** Motivo con que el chofer rechazó la ventana (obligatorio al rechazar). */
  @Column({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason!: string | null;

  /** Ventana que el chofer propone en lugar de la ofrecida. */
  @Column({ name: 'alt_window_start', type: 'timestamptz', nullable: true })
  altWindowStart!: Date | null;

  @Column({ name: 'alt_window_end', type: 'timestamptz', nullable: true })
  altWindowEnd!: Date | null;
}
