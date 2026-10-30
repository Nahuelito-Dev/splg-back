import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
  Check,
  ForeignKey,
} from 'typeorm';
import { CashMovement } from '../../cash/entities/cash-movement.entity';
import { MaintenancePlan } from './maintenance-plan.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { Car } from '../../car/entities/car.entity';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { Employee } from '../../employee/entities/employee.entity';
import { MaintenanceTaskAttachment } from './maintenance-task-attachment.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';

export enum MaintenanceTaskStatus {
  FORECAST = 'forecast',
  SCHEDULED = 'scheduled',
  IN_PROGRESS = 'in_progress',
  DONE = 'done',
  OVERDUE = 'overdue',
  CANCELLED = 'cancelled',
}

/**
 * Tarea de mantenimiento
 * Cada vencimiento concreto de un plan: una póliza, una VTV, un service.
 * Casos: CU-136 a CU-142, CU-183 a CU-185 y CU-105 (M1)
 */
@Check(
  'CHK_maintenance_task_valores',
  `coalesce("cost", 0) >= 0 AND coalesce("due_km", 0) >= 0 AND coalesce("odometer_km", 0) >= 0`,
)
@Check(
  'CHK_maintenance_task_un_sujeto',
  `num_nonnulls("car_id", "delivery_id", "employee_id") = 1`,
)
@Check(
  'CHK_maintenance_task_hecha_fecha',
  `"status" <> 'done' OR "performed_at" IS NOT NULL`,
)
@Check(
  'CHK_maintenance_task_pago',
  `num_nonnulls("cash_movement_id", "paid_at", "paid_amount") IN (0, 3) AND coalesce("paid_amount", 1) > 0 AND ("cash_movement_id" IS NULL OR "status" = 'done')`,
)
@ForeignKey(
  () => CashMovement,
  ['cash_movement_id', 'distributor_id'],
  ['movement_id', 'distributor_id'],
  {
    name: 'FK_maintenance_task_cash_movement_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Entity('maintenance_task')
export class MaintenanceTask {
  @PrimaryGeneratedColumn('uuid', { name: 'task_id' })
  taskId!: string;

  @ManyToOne(() => MaintenancePlan, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'plan_id' })
  plan!: MaintenancePlan;

  @Column({ name: 'plan_id', type: 'uuid' })
  planId!: string;

  @Index()
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor!: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @ManyToOne(() => Car, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'car_id' })
  car?: Car;

  @Column({ name: 'car_id', type: 'uuid', nullable: true })
  carId!: string | null;

  @ManyToOne(() => Delivery, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'delivery_id' })
  delivery?: Delivery;

  @Column({ name: 'delivery_id', type: 'uuid', nullable: true })
  deliveryId!: string | null;

  @Index('IDX_maintenance_task_employee')
  @ManyToOne(() => Employee, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'employee_id' })
  employee?: Employee;

  @Column({ name: 'employee_id', type: 'uuid', nullable: true })
  employeeId!: string | null;

  @Column({
    name: 'status',
    type: 'enum',
    enum: MaintenanceTaskStatus,

    nullable: false,
    default: MaintenanceTaskStatus.FORECAST,
  })
  status!: MaintenanceTaskStatus;

  /**
   * Inicio de la vigencia del documento (póliza, habilitación). Fecha de
   * calendario, normalizada como `dueAt`. Sin ella, el costo del vehículo
   * prorratea la póliza con un año hacia atrás desde el vencimiento.
   */
  @Column({ name: 'valid_from', type: 'timestamptz', nullable: true })
  validFrom!: Date | null;

  @Column({ name: 'due_at', type: 'timestamptz', nullable: true })
  dueAt!: Date | null;

  @Column({ name: 'due_km', type: 'integer', nullable: true })
  dueKm!: number | null;

  @Column({ name: 'predicted_due_at', type: 'timestamptz', nullable: true })
  predictedDueAt!: Date | null;

  @Column({ name: 'scheduled_at', type: 'timestamptz', nullable: true })
  scheduledAt!: Date | null;

  @Column({ name: 'performed_at', type: 'timestamptz', nullable: true })
  performedAt!: Date | null;

  @Column({ name: 'odometer_km', type: 'integer', nullable: true })
  odometerKm!: number | null;

  @Column({
    name: 'cost',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
    nullable: true,
  })
  cost!: number | null;

  /** Salida de la caja con que se pagó el servicio (`null` mientras esté sin pagar). */
  @ForeignKey('cash_movement', {
    name: 'FK_maintenance_task_cash_movement',
    onDelete: 'RESTRICT',
  })
  @Column({ name: 'cash_movement_id', type: 'uuid', nullable: true })
  cashMovementId!: string | null;

  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt!: Date | null;

  @Column({
    name: 'paid_amount',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
    nullable: true,
  })
  paidAmount!: number | null;

  @Column({ name: 'provider', type: 'varchar', length: 120, nullable: true })
  provider!: string | null;

  @Column({
    name: 'reference_number',
    type: 'varchar',
    length: 60,
    nullable: true,
  })
  referenceNumber!: string | null;

  @Column({ name: 'category', type: 'varchar', length: 10, nullable: true })
  category!: string | null;

  @Column({ name: 'alerted_at', type: 'timestamptz', nullable: true })
  alertedAt!: Date | null;

  @Column({ name: 'notes', type: 'text', nullable: true })
  notes!: string | null;

  /**
   * Datos propios del tipo de documento (número de certificado, aseguradora,
   * fecha del examen...). La forma la fija `plan.documentKind`
   * (`domain/document-details.ts`).
   */
  @Column({ name: 'details', type: 'jsonb', nullable: true })
  details!: Record<string, string> | null;

  @OneToMany(() => MaintenanceTaskAttachment, (a) => a.task)
  attachments?: MaintenanceTaskAttachment[];
}
