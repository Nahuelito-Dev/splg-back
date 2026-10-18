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
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { Car, FuelType } from '../../car/entities/car.entity';
import { Employee } from '../../employee/entities/employee.entity';
import { User } from '../../users/entities/user.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';

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
