import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  Check,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { Car } from '../../car/entities/car.entity';
import { Employee } from '../../employee/entities/employee.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';

/** Ciclo de la multa: pendiente, apelada, pagada o anulada. Pagada y anulada no vuelven atrás. */
export enum TrafficFineStatus {
  PENDING = 'pending',
  APPEALED = 'appealed',
  PAID = 'paid',
  VOIDED = 'voided',
}

/**
 * Multa de tránsito de un vehículo (CU-198, CU-199, CU-200, CU-323 a CU-326).
 * Se conserva siempre: anularla es un estado, con su motivo. El acta es única
 * por distribuidora y jurisdicción.
 */
@Entity('traffic_fine')
@Index('UQ_traffic_fine_act', ['distributorId', 'jurisdiction', 'actNumber'], {
  unique: true,
})
@Index('IDX_traffic_fine_car', ['carId', 'occurredAt'])
@Index('IDX_traffic_fine_status_due', ['distributorId', 'status', 'dueDate'])
@Check('CHK_traffic_fine_amount', '"amount" > 0')
export class TrafficFine {
  @PrimaryGeneratedColumn('uuid', { name: 'fine_id' })
  fineId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @ManyToOne(() => Car, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'car_id' })
  car?: Car;

  @Column({ name: 'car_id', type: 'uuid' })
  carId!: string;

  /** Responsable: el chofer que tenía el vehículo en el instante de la infracción, o el que se indique. */
  @ManyToOne(() => Employee, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'employee_id' })
  employee?: Employee | null;

  @Column({ name: 'employee_id', type: 'uuid', nullable: true })
  employeeId!: string | null;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;

  @Column({ name: 'jurisdiction', type: 'varchar', length: 80 })
  jurisdiction!: string;

  @Column({ name: 'act_number', type: 'varchar', length: 40 })
  actNumber!: string;

  @Column({ name: 'infraction', type: 'text' })
  infraction!: string;

  @Column({
    name: 'amount',
    type: 'decimal',
    precision: 12,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  amount!: number;

  /** Importe con el descuento de pago voluntario. */
  @Column({
    name: 'voluntary_payment_amount',
    type: 'decimal',
    precision: 12,
    scale: 2,
    transformer: columnNumericTransformer,
    nullable: true,
  })
  voluntaryPaymentAmount!: number | null;

  /** Fecha de calendario `YYYY-MM-DD`. */
  @Column({ name: 'due_date', type: 'date', nullable: true })
  dueDate!: string | null;

  @Column({
    name: 'status',
    type: 'enum',
    enum: TrafficFineStatus,
    default: TrafficFineStatus.PENDING,
  })
  status!: TrafficFineStatus;

  /** Día del pago, como el inicio de ese día en hora argentina. */
  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt!: Date | null;

  /** Lo efectivamente pagado: suele ser el del pago voluntario, menor que `amount`. */
  @Column({
    name: 'paid_amount',
    type: 'decimal',
    precision: 12,
    scale: 2,
    transformer: columnNumericTransformer,
    nullable: true,
  })
  paidAmount!: number | null;

  /** Imputada al chofer (CU-200): la asume el empleado y no cuenta como costo del vehículo. */
  @Column({ name: 'charged_to_employee', type: 'boolean', default: false })
  chargedToEmployee!: boolean;

  @Column({ name: 'void_reason', type: 'text', nullable: true })
  voidReason!: string | null;

  @Column({ name: 'voided_at', type: 'timestamptz', nullable: true })
  voidedAt!: Date | null;

  /** Cuándo se avisó el vencimiento (CU-326); `null` = sin avisar. */
  @Column({ name: 'alerted_at', type: 'timestamptz', nullable: true })
  alertedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
