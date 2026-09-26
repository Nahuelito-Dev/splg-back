import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';
import { CylinderRecoveryCase } from './cylinder-recovery-case.entity';
import { ProposalStatus } from '../../common/enums/proposal-status.enum';

export enum RecoveryNoticeKind {
  REMINDER = 'reminder',
  PICKUP_OFFER = 'pickup_offer',
  DEPOSIT_WARNING = 'deposit_warning',
}

/**
 * Aviso de recupero
 * Cada aviso u oferta de retiro enviados dentro de un caso.
 * Casos: CU-108 (M4)
 */
@Entity('cylinder_recovery_notice')
export class CylinderRecoveryNotice {
  @PrimaryGeneratedColumn('uuid', { name: 'notice_id' })
  noticeId!: string;

  @Index()
  @ManyToOne(() => CylinderRecoveryCase, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'case_id' })
  recoveryCase!: CylinderRecoveryCase;

  @Column({ name: 'case_id', type: 'uuid' })
  caseId!: string;

  @Column({ name: 'step', type: 'integer', nullable: false })
  step!: number;

  @Column({
    name: 'kind',
    type: 'enum',
    enum: RecoveryNoticeKind,
    enumName: 'recovery_notice_kind_enum',
    nullable: false,
  })
  kind!: RecoveryNoticeKind;

  @Column({
    name: 'status',
    type: 'enum',
    enum: ProposalStatus,
    enumName: 'proposal_status_enum',
    nullable: true,
  })
  status!: ProposalStatus | null;

  @CreateDateColumn({ name: 'sent_at', type: 'timestamptz' })
  sentAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: false })
  expiresAt!: Date;
}
