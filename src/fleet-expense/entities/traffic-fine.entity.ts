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
  ForeignKey,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { Car } from '../../car/entities/car.entity';
import { Employee } from '../../employee/entities/employee.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { CashMovement } from '../../cash/entities/cash-movement.entity';
import { Attachment } from '../../attachment/entities/attachment.entity';

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
@Check(
  'CHK_traffic_fine_pago_voluntario',
  `"voluntary_payment_amount" IS NULL OR ("voluntary_payment_amount" > 0 AND "voluntary_payment_amount" <= "amount")`,
)
@Check(
  'CHK_traffic_fine_importe_pagado',
  `"paid_amount" IS NULL OR "paid_amount" > 0`,
)
@Check(
  'CHK_traffic_fine_pagada_datos',
  `"status" <> 'paid' OR ("paid_at" IS NOT NULL AND "paid_amount" IS NOT NULL)`,
)
@Check(
  'CHK_traffic_fine_anulada_fecha',
  `"status" <> 'voided' OR "voided_at" IS NOT NULL`,
)
@Check(
  'CHK_traffic_fine_enlace_de_pago',
  `"payment_url" IS NULL OR ("payment_url" ~ '^https://[^[:space:]]+$' AND char_length("payment_url") <= 500)`,
)
@Check(
  'CHK_traffic_fine_comprobante_de_pago',
  `("receipt_attachment_id" IS NULL AND "operation_number" IS NULL) OR ("status" = 'paid' AND "receipt_attachment_id" IS NOT NULL AND "cash_movement_id" IS NOT NULL)`,
)
@ForeignKey(
  () => Attachment,
  ['receipt_attachment_id', 'distributor_id'],
  ['attachment_id', 'distributor_id'],
  {
    name: 'FK_traffic_fine_receipt_attachment_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@ForeignKey(
  () => CashMovement,
  ['cash_movement_id', 'distributor_id'],
  ['movement_id', 'distributor_id'],
  {
    name: 'FK_traffic_fine_cash_movement_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Entity('traffic_fine')
@Index('UQ_traffic_fine_act', ['distributorId', 'jurisdiction', 'actNumber'], {
  unique: true,
})
@Index('IDX_traffic_fine_car', ['carId', 'occurredAt'])
@Index('IDX_traffic_fine_status_due', ['distributorId', 'status', 'dueDate'])
@Check('CHK_traffic_fine_amount', '"amount" > 0')
@Check(
  'CHK_traffic_fine_pago_contra_importe',
  '"paid_amount" IS NULL OR "paid_amount" <= "amount"',
)
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

  /** Salida de la caja con que se pagó en efectivo; `null` si no se pagó en efectivo o no hay cajas. */
  @ForeignKey('cash_movement', {
    name: 'FK_traffic_fine_cash_movement',
    onDelete: 'RESTRICT',
  })
  @Column({ name: 'cash_movement_id', type: 'uuid', nullable: true })
  cashMovementId!: string | null;

  /** Enlace de pago (https): portal del municipio o Mercado Pago. */
  @Column({ name: 'payment_url', type: 'varchar', length: 500, nullable: true })
  paymentUrl!: string | null;

  /** Código de pago o de barras que el portal pide al pagar. */
  @Column({ name: 'payment_code', type: 'varchar', length: 80, nullable: true })
  paymentCode!: string | null;

  /** Número de operación del comprobante; sólo en una multa pagada con comprobante. */
  @Column({
    name: 'operation_number',
    type: 'varchar',
    length: 60,
    nullable: true,
  })
  operationNumber!: string | null;

  /** Comprobante subido al pagar (adjunto de la multa). Las pagadas por la v1 no lo tienen. */
  @ForeignKey('attachment', {
    name: 'FK_traffic_fine_receipt_attachment',
    onDelete: 'RESTRICT',
  })
  @Column({ name: 'receipt_attachment_id', type: 'uuid', nullable: true })
  receiptAttachmentId!: string | null;

  /** Imputada al chofer (CU-200): la asume el empleado y no cuenta como costo del vehículo. */
  @Column({ name: 'charged_to_employee', type: 'boolean', default: false })
  chargedToEmployee!: boolean;

  @Column({ name: 'void_reason', type: 'text', nullable: true })
  voidReason!: string | null;

  @Column({ name: 'voided_at', type: 'timestamptz', nullable: true })
  voidedAt!: Date | null;

  /** Marca de las multas que el aviso por correo anterior ya avisó: la bandeja no las repite. Un vencimiento nuevo la limpia. */
  @Column({ name: 'alerted_at', type: 'timestamptz', nullable: true })
  alertedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
