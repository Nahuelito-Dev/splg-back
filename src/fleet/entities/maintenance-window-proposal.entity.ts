import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { MaintenanceTask } from './maintenance-task.entity';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { ProposalStatus } from '../../common/enums/proposal-status.enum';

/**
 * Propuesta de ventana de taller
 * Una ventana ofrecida al chofer, de a una por vez, con vigencia.
 * Casos: CU-136 a CU-142 y CU-105 (M1)
 */
@Entity('maintenance_window_proposal')
export class MaintenanceWindowProposal {
  @PrimaryGeneratedColumn('uuid', { name: 'proposal_id' })
  proposalId!: string;

  @ManyToOne(() => MaintenanceTask, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'task_id' })
  task!: MaintenanceTask;

  @Column({ name: 'task_id', type: 'uuid' })
  taskId!: string;

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
    enum: ProposalStatus,
    enumName: 'proposal_status_enum',
    nullable: false,
    default: ProposalStatus.PENDING,
  })
  status!: ProposalStatus;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: false })
  expiresAt!: Date;

  @Column({ name: 'responded_at', type: 'timestamptz', nullable: true })
  respondedAt!: Date | null;
}
