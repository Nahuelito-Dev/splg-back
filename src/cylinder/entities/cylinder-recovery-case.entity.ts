import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';
import { Cylinder } from './cylinder.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';

export enum RecoveryCaseStatus {
  OPEN = 'open',
  RETURNED = 'returned',
  ESCALATED = 'escalated',
  DEPOSIT_CHARGED = 'deposit_charged',
  WRITTEN_OFF = 'written_off',
  CLOSED_NO_CHARGE = 'closed_no_charge',
}

/**
 * Caso de recupero
 * La gestión de un envase retenido por un cliente.
 * Casos: CU-108 (M4)
 */
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
