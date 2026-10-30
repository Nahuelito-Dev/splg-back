import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Attachment } from '../../attachment/entities/attachment.entity';
import { CashMovement } from '../../cash/entities/cash-movement.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';
import { InstallmentStatus } from '../domain/insurance.enums';
import { InsurancePolicy } from './insurance-policy.entity';

/**
 * Cuota mensual de una póliza. Pagarla la deja `paid` con el comprobante y el
 * egreso de caja asociados: o están todos esos datos o ninguno
 * (`CHK_insurance_installment_pagada`).
 */
@Check('CHK_insurance_installment_importe', `"amount" > 0`)
@Check(
  'CHK_insurance_installment_numero',
  `"number" >= 1 AND "total" >= 1 AND "number" <= "total"`,
)
@Check('CHK_insurance_installment_gracia', `"grace_until" >= "due_date"`)
@Check(
  'CHK_insurance_installment_pagada',
  `("status" = 'paid' AND num_nonnulls("paid_at", "paid_amount", "paid_by_user_id", "cash_movement_id", "receipt_attachment_id") = 5 AND "paid_amount" > 0) OR ("status" <> 'paid' AND num_nonnulls("paid_at", "paid_amount", "operation_number", "paid_by_user_id", "cash_movement_id", "receipt_attachment_id") = 0)`,
)
@ForeignKey(
  () => InsurancePolicy,
  ['policy_id', 'distributor_id'],
  ['policy_id', 'distributor_id'],
  {
    name: 'FK_insurance_installment_policy_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@ForeignKey(
  () => CashMovement,
  ['cash_movement_id', 'distributor_id'],
  ['movement_id', 'distributor_id'],
  {
    name: 'FK_insurance_installment_cash_movement_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Unique('UQ_insurance_installment_id_distribuidora', [
  'installmentId',
  'distributorId',
])
@Entity('insurance_installment')
@Index('UQ_insurance_installment_numero', ['policyId', 'number'], {
  unique: true,
})
@Index('IDX_insurance_installment_vencimiento', [
  'distributorId',
  'status',
  'dueDate',
])
export class InsuranceInstallment {
  @PrimaryGeneratedColumn('uuid', { name: 'installment_id' })
  installmentId!: string;

  @Index('IDX_insurance_installment_distributor')
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @ManyToOne(() => InsurancePolicy, (p) => p.installments, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'policy_id' })
  policy?: InsurancePolicy;

  @Column({ name: 'policy_id', type: 'uuid' })
  policyId!: string;

  /** Número de cuota (`number` de `total`). */
  @Column({ name: 'number', type: 'integer' })
  number!: number;

  @Column({ name: 'total', type: 'integer' })
  total!: number;

  /** Fecha de calendario `YYYY-MM-DD`. */
  @Column({ name: 'due_date', type: 'date' })
  dueDate!: string;

  /** Hasta cuándo el pago se juzga en término. */
  @Column({ name: 'grace_until', type: 'date' })
  graceUntil!: string;

  @Column({
    name: 'amount',
    type: 'decimal',
    precision: 12,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  amount!: number;

  @Column({
    name: 'status',
    type: 'enum',
    enum: InstallmentStatus,
    default: InstallmentStatus.PENDING,
  })
  status!: InstallmentStatus;

  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt!: Date | null;

  /** Lo efectivamente pagado: puede diferir de `amount` (intereses, descuento). */
  @Column({
    name: 'paid_amount',
    type: 'decimal',
    precision: 12,
    scale: 2,
    transformer: columnNumericTransformer,
    nullable: true,
  })
  paidAmount!: number | null;

  @Column({
    name: 'operation_number',
    type: 'varchar',
    length: 60,
    nullable: true,
  })
  operationNumber!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'paid_by_user_id' })
  paidBy?: User | null;

  @Column({ name: 'paid_by_user_id', type: 'uuid', nullable: true })
  paidByUserId!: string | null;

  /** Egreso de la caja con que se pagó. */
  @ForeignKey('cash_movement', {
    name: 'FK_insurance_installment_cash_movement',
    onDelete: 'RESTRICT',
  })
  @Column({ name: 'cash_movement_id', type: 'uuid', nullable: true })
  cashMovementId!: string | null;

  @ManyToOne(() => Attachment, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'receipt_attachment_id' })
  receipt?: Attachment | null;

  @Column({ name: 'receipt_attachment_id', type: 'uuid', nullable: true })
  receiptAttachmentId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
