import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  Check,
} from 'typeorm';
import { CashMovement } from '../../cash/entities/cash-movement.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { Employee } from '../../employee/entities/employee.entity';
import { User } from '../../users/entities/user.entity';
import { LiquidationStatus } from '../domain/commission.enums';

/**
 * Liquidación de las comisiones de un chofer en un período: nace en borrador,
 * se aprueba (se congela) y se paga con un egreso de caja. Una pagada no se
 * anula desde acá porque el pago ya sacó dinero de una caja.
 */
@Check('CHK_driver_liquidation_periodo', `"period_from" <= "period_to"`)
@Check(
  'CHK_driver_liquidation_montos',
  `"gross" >= 0 AND "deductions" >= 0 AND "net" = "gross" - "deductions"`,
)
@Check(
  'CHK_driver_liquidation_aprobada',
  `"status" NOT IN ('approved', 'paid') OR "approved_at" IS NOT NULL`,
)
@Check(
  'CHK_driver_liquidation_pagada',
  `("status" = 'paid') = ("paid_at" IS NOT NULL)`,
)
@Check(
  'CHK_driver_liquidation_anulada',
  `("status" = 'voided') = ("voided_at" IS NOT NULL)`,
)
@Entity('driver_liquidation')
@Index('UQ_driver_liquidation_numero', ['distributorId', 'number'], {
  unique: true,
})
@Index('IDX_driver_liquidation_empleado', ['employeeId', 'status'])
export class DriverLiquidation {
  @PrimaryGeneratedColumn('uuid', { name: 'liquidation_id' })
  liquidationId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Index('IDX_driver_liquidation_distributor')
  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  /** Número correlativo por distribuidora (`document_sequence`). */
  @Column({ type: 'int' })
  number!: number;

  @ManyToOne(() => Employee, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'employee_id' })
  employee?: Employee;

  @Column({ name: 'employee_id', type: 'uuid' })
  employeeId!: string;

  @Column({ name: 'period_from', type: 'date' })
  periodFrom!: string;

  @Column({ name: 'period_to', type: 'date' })
  periodTo!: string;

  /** Σ de los asientos que suman. */
  @Column({
    type: 'decimal',
    precision: 12,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  gross!: number;

  /** Σ (en positivo) de las deducciones. */
  @Column({
    type: 'decimal',
    precision: 12,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  deductions!: number;

  @Column({
    type: 'decimal',
    precision: 12,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  net!: number;

  @Column({
    type: 'enum',
    enum: LiquidationStatus,
    default: LiquidationStatus.DRAFT,
  })
  status!: LiquidationStatus;

  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt!: Date | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'approved_by_user_id' })
  approvedBy?: User | null;

  @Column({ name: 'approved_by_user_id', type: 'uuid', nullable: true })
  approvedByUserId!: string | null;

  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt!: Date | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'paid_by_user_id' })
  paidBy?: User | null;

  @Column({ name: 'paid_by_user_id', type: 'uuid', nullable: true })
  paidByUserId!: string | null;

  @Column({ name: 'voided_at', type: 'timestamptz', nullable: true })
  voidedAt!: Date | null;

  @ManyToOne(() => CashMovement, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'cash_movement_id' })
  cashMovement?: CashMovement | null;

  @Column({ name: 'cash_movement_id', type: 'uuid', nullable: true })
  cashMovementId!: string | null;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'created_by_user_id' })
  createdBy?: User;

  @Column({ name: 'created_by_user_id', type: 'uuid' })
  createdByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
