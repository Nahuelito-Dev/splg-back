import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  Check,
} from 'typeorm';
import { CashBox } from '../../cash/entities/cash-box.entity';
import { CashMovement } from '../../cash/entities/cash-movement.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { TruckLoad } from '../../truck-load/entities/truck-load.entity';
import { User } from '../../users/entities/user.entity';
import {
  DifferenceResolution,
  DriverSettlementStatus,
} from '../domain/driver-settlement.enums';
import { DriverSettlementCollection } from './driver-settlement-collection.entity';
import { DriverSettlementExpense } from './driver-settlement-expense.entity';
import { DriverSettlementOrder } from './driver-settlement-order.entity';

/**
 * Rendición diaria de un chofer: el efectivo que cobró (pedidos en efectivo y
 * cobros de cuenta corriente en la calle) contra lo que declara entregar. Una
 * por chofer y día de negocio (hora argentina); si el chofer tuvo una carga de
 * camión ese día, queda atada a ella. Al aprobarla, el efectivo entra a una caja
 * por el libro.
 */
@Check(
  'CHK_driver_settlement_montos',
  `"expected_cash" >= 0 AND "driver_expenses" >= 0 AND ("declared_cash" IS NULL OR "declared_cash" >= 0)`,
)
@Check(
  'CHK_driver_settlement_presentada',
  `"status" = 'open' OR ("submitted_at" IS NOT NULL AND "declared_cash" IS NOT NULL)`,
)
@Check(
  'CHK_driver_settlement_aprobada',
  `("status" = 'approved') = ("approved_at" IS NOT NULL)`,
)
@Check(
  'CHK_driver_settlement_diferencia',
  `"difference" IS NULL OR "difference" = "declared_cash" + "driver_expenses" - "expected_cash"`,
)
@Entity('driver_settlement')
@Index('UQ_driver_settlement_numero', ['distributorId', 'number'], {
  unique: true,
})
@Index('UQ_driver_settlement_chofer_dia', ['deliveryId', 'businessDate'], {
  unique: true,
})
@Index('UQ_driver_settlement_carga', ['truckLoadId'], {
  unique: true,
  where: '"truck_load_id" IS NOT NULL',
})
@Index('IDX_driver_settlement_fecha', ['distributorId', 'businessDate'])
@Index('IDX_driver_settlement_estado', ['distributorId', 'status'])
export class DriverSettlement {
  @PrimaryGeneratedColumn('uuid', { name: 'settlement_id' })
  settlementId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Index('IDX_driver_settlement_chofer')
  @ManyToOne(() => Delivery, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'delivery_id' })
  delivery?: Delivery;

  @Column({ name: 'delivery_id', type: 'uuid' })
  deliveryId!: string;

  /** Número correlativo por distribuidora (`document_sequence`). */
  @Column({ type: 'int' })
  number!: number;

  /** Turno del camión de ese día, si el chofer tuvo carga. */
  @ManyToOne(() => TruckLoad, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'truck_load_id' })
  truckLoad?: TruckLoad | null;

  @Column({ name: 'truck_load_id', type: 'uuid', nullable: true })
  truckLoadId!: string | null;

  /** Día de negocio en hora argentina (YYYY-MM-DD). */
  @Column({ name: 'business_date', type: 'date' })
  businessDate!: string;

  @Column({
    type: 'enum',
    enum: DriverSettlementStatus,
    default: DriverSettlementStatus.OPEN,
  })
  status!: DriverSettlementStatus;

  /** Efectivo que el chofer debería entregar. Se recalcula al presentar. */
  @Column({
    name: 'expected_cash',
    type: 'decimal',
    precision: 12,
    scale: 2,
    default: 0,
    transformer: columnNumericTransformer,
  })
  expectedCash!: number;

  @Column({
    name: 'declared_cash',
    type: 'decimal',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: columnNumericTransformer,
  })
  declaredCash!: number | null;

  /** Gastos que el chofer pagó con la cobranza (combustible, peaje). */
  @Column({
    name: 'driver_expenses',
    type: 'decimal',
    precision: 12,
    scale: 2,
    default: 0,
    transformer: columnNumericTransformer,
  })
  driverExpenses!: number;

  /** Declarado + gastos − esperado: negativa es faltante, positiva sobrante. */
  @Column({
    type: 'decimal',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: columnNumericTransformer,
  })
  difference!: number | null;

  @Column({
    name: 'difference_resolution',
    type: 'enum',
    enum: DifferenceResolution,
    nullable: true,
  })
  differenceResolution!: DifferenceResolution | null;

  @ManyToOne(() => CashBox, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'destination_cash_box_id' })
  destinationCashBox?: CashBox | null;

  @Column({ name: 'destination_cash_box_id', type: 'uuid', nullable: true })
  destinationCashBoxId!: string | null;

  /** Entrada a caja que generó la aprobación. */
  @ManyToOne(() => CashMovement, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'cash_movement_id' })
  cashMovement?: CashMovement | null;

  @Column({ name: 'cash_movement_id', type: 'uuid', nullable: true })
  cashMovementId!: string | null;

  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true })
  submittedAt!: Date | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'submitted_by_user_id' })
  submittedBy?: User | null;

  @Column({ name: 'submitted_by_user_id', type: 'uuid', nullable: true })
  submittedByUserId!: string | null;

  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt!: Date | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'approved_by_user_id' })
  approvedBy?: User | null;

  @Column({ name: 'approved_by_user_id', type: 'uuid', nullable: true })
  approvedByUserId!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  /** Cuándo se avisó por mail que quedó sin cerrar; evita repetir el aviso. */
  @Column({ name: 'overdue_alerted_at', type: 'timestamptz', nullable: true })
  overdueAlertedAt!: Date | null;

  @OneToMany(() => DriverSettlementOrder, (o) => o.settlement)
  orders?: DriverSettlementOrder[];

  @OneToMany(() => DriverSettlementExpense, (e) => e.settlement)
  expenses?: DriverSettlementExpense[];

  @OneToMany(() => DriverSettlementCollection, (c) => c.settlement)
  collections?: DriverSettlementCollection[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
