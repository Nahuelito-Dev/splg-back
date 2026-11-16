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
  DeleteDateColumn,
  ForeignKey,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { Car, FuelType } from '../../car/entities/car.entity';
import { Employee } from '../../employee/entities/employee.entity';
import { User } from '../../users/entities/user.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { CashMovement } from '../../cash/entities/cash-movement.entity';

export enum FuelPaymentMethod {
  CASH_BOX = 'cash_box',
  DRIVER_CASH = 'driver_cash',
  CARD = 'card',
  FUEL_ACCOUNT = 'fuel_account',
}

/**
 * Carga de combustible de un vehículo (CU-195, CU-320 a CU-322). Es un
 * registro propio, no un dato del vehículo: cada carga conserva su fecha,
 * precio y kilometraje, y de ahí salen el consumo por tramo y el costo.
 * `deletedAt` es la anulación (CU-321): la fila se conserva y deja de contar.
 */
@Check('CHK_fuel_load_precio', `"unit_price" > 0`)
@Check(
  'CHK_fuel_load_pago',
  `("cash_movement_id" IS NULL) = ("paid_at" IS NULL)`,
)
@Check('CHK_fuel_load_odometro', `"odometer_km" >= 0`)
@ForeignKey(
  () => CashMovement,
  ['cash_movement_id', 'distributor_id'],
  ['movement_id', 'distributor_id'],
  {
    name: 'FK_fuel_load_cash_movement_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Entity('fuel_load')
@Index('IDX_fuel_load_car_loaded_at', ['carId', 'loadedAt'])
@Index('IDX_fuel_load_distributor_loaded_at', ['distributorId', 'loadedAt'])
@Check('CHK_fuel_load_liters', '"liters" > 0')
@Check('CHK_fuel_load_total', '"total_amount" >= 0')
export class FuelLoad {
  @PrimaryGeneratedColumn('uuid', { name: 'fuel_load_id' })
  fuelLoadId!: string;

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

  /** Quién cargó (su legajo), si se lo identifica. */
  @ManyToOne(() => Employee, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'employee_id' })
  employee?: Employee | null;

  @Column({ name: 'employee_id', type: 'uuid', nullable: true })
  employeeId!: string | null;

  @Column({ name: 'loaded_at', type: 'timestamptz' })
  loadedAt!: Date;

  @Column({
    name: 'fuel_type',
    type: 'enum',
    enum: FuelType,
    enumName: 'fuel_type_enum',
  })
  fuelType!: FuelType;

  @Column({
    name: 'liters',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  liters!: number;

  @Column({
    name: 'unit_price',
    type: 'decimal',
    precision: 12,
    scale: 3,
    transformer: columnNumericTransformer,
  })
  unitPrice!: number;

  @Column({
    name: 'total_amount',
    type: 'decimal',
    precision: 12,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  totalAmount!: number;

  @Column({ name: 'odometer_km', type: 'integer' })
  odometerKm!: number;

  /** El consumo se mide entre cargas de tanque lleno. */
  @Column({ name: 'is_full_tank', type: 'boolean', default: true })
  isFullTank!: boolean;

  @Column({ name: 'station', type: 'varchar', length: 120, nullable: true })
  station!: string | null;

  @Column({
    name: 'payment_method',
    type: 'enum',
    enum: FuelPaymentMethod,
    enumName: 'fuel_payment_method_enum',
  })
  paymentMethod!: FuelPaymentMethod;

  @Column({
    name: 'receipt_number',
    type: 'varchar',
    length: 40,
    nullable: true,
  })
  receiptNumber!: string | null;

  /**
   * Salida de la caja con que se pagó la carga (`cash_box`). `null` en la que
   * pagó el chofer con su efectivo y en la que cargó el chofer y el
   * administrador todavía no asentó en una caja.
   */
  @ForeignKey('cash_movement', {
    name: 'FK_fuel_load_cash_movement',
    onDelete: 'RESTRICT',
  })
  @Column({ name: 'cash_movement_id', type: 'uuid', nullable: true })
  cashMovementId!: string | null;

  /** Cuándo se pagó la carga: el de la salida de caja (`cashMovementId`). */
  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt!: Date | null;

  /** La registró el chofer desde su app: no elige caja y su medio de pago no se cambia entre efectivo propio y caja. */
  @Column({ name: 'registered_by_driver', type: 'boolean', default: false })
  registeredByDriver!: boolean;

  /** Carga `cash_box` anterior al asiento de caja: se resolvió fuera del libro y no se ofrece para asentar. */
  @Column({ name: 'cash_payment_legacy', type: 'boolean', default: false })
  cashPaymentLegacy!: boolean;

  /** El consumo del tramo se apartó más de un 25 % del habitual. */
  @Column({ name: 'anomaly', type: 'boolean', default: false })
  anomaly!: boolean;

  @Column({ name: 'notes', type: 'text', nullable: true })
  notes!: string | null;

  /** Nota de quien forzó un kilometraje menor que el de la carga anterior. */
  @Column({ name: 'odometer_correction_note', type: 'text', nullable: true })
  odometerCorrectionNote!: string | null;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'created_by_user_id' })
  createdBy?: User;

  @Column({ name: 'created_by_user_id', type: 'uuid' })
  createdByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
