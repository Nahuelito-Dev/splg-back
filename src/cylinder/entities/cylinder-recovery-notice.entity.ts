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
import { CylinderRecoveryCase } from './cylinder-recovery-case.entity';
import { ProposalStatus } from '../../common/enums/proposal-status.enum';
import { Order } from '../../order/entities/order.entity';

export enum RecoveryNoticeKind {
  REMINDER = 'reminder',
  PICKUP_OFFER = 'pickup_offer',
  DEPOSIT_WARNING = 'deposit_warning',
}

/**
 * Aviso de recupero
 * Cada aviso u oferta de retiro enviados dentro de un caso. Un escalón envía un
 * solo aviso (recordatorio o aviso del depósito); la oferta de retiro lleva el
 * pedido en el que el chofer retiraría el envase y su respuesta.
 * Casos: CU-108 (M5)
 */
@Check(
  'CHK_recovery_notice_oferta',
  `(("kind" = 'pickup_offer') = ("order_id" IS NOT NULL)) AND (("kind" = 'pickup_offer') = ("status" IS NOT NULL)) AND ("status" NOT IN ('accepted', 'rejected') OR "responded_at" IS NOT NULL) AND ("status" <> 'pending' OR "responded_at" IS NULL) AND ("expires_at" >= "sent_at") AND ("step" BETWEEN 1 AND 3)`,
)
@Index('UQ_recovery_notice_aviso_por_escalon', ['caseId', 'step'], {
  unique: true,
  where: `"kind" <> 'pickup_offer'`,
})
@Index('UQ_recovery_notice_oferta_por_pedido', ['caseId', 'orderId'], {
  unique: true,
  where: `"kind" = 'pickup_offer'`,
})
@Index('UQ_recovery_notice_oferta_viva', ['caseId'], {
  unique: true,
  where: `"kind" = 'pickup_offer' AND "status" IN ('pending', 'accepted')`,
})
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

  /** Pedido en el que se ofrece retirar el envase (sólo en la oferta de retiro). */
  @ManyToOne(() => Order, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id' })
  order?: Order;

  @Index('IDX_recovery_notice_pedido')
  @Column({ name: 'order_id', type: 'uuid', nullable: true })
  orderId!: string | null;

  @CreateDateColumn({ name: 'sent_at', type: 'timestamptz' })
  sentAt!: Date;

  /** Cuándo respondió el cliente a la oferta (aceptada o rechazada). */
  @Column({ name: 'responded_at', type: 'timestamptz', nullable: true })
  respondedAt!: Date | null;

  /** Por qué no se pudo retirar el envase (lo informa el chofer). */
  @Column({
    name: 'response_note',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  responseNote!: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: false })
  expiresAt!: Date;
}
