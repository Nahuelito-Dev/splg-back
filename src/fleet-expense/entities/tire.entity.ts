import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
  Check,
  ForeignKey,
} from 'typeorm';
import { CashMovement } from '../../cash/entities/cash-movement.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { Car } from '../../car/entities/car.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';

export enum TireStatus {
  IN_STOCK = 'in_stock',
  MOUNTED = 'mounted',
  RETIRED = 'retired',
}

/**
 * Neumático (CU-205). No se edita: su estado, vehículo y posición cambian con
 * los movimientos (`TireEvent`, CU-206), que son su historial.
 */
@Check(
  'CHK_tire_valores',
  `"cost" >= 0 AND "km_traveled" >= 0 AND "retread_count" >= 0`,
)
@Check(
  'CHK_tire_montaje',
  `("status" = 'mounted') = ("car_id" IS NOT NULL AND "position" IS NOT NULL)`,
)
@Check('CHK_tire_pago', `("cash_movement_id" IS NULL) = ("paid_at" IS NULL)`)
@ForeignKey(
  () => CashMovement,
  ['cash_movement_id', 'distributor_id'],
  ['movement_id', 'distributor_id'],
  {
    name: 'FK_tire_cash_movement_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Entity('tire')
@Index('UQ_tire_serial', ['distributorId', 'serialNumber'], { unique: true })
@Index('UQ_tire_posicion_ocupada', ['carId', 'position'], {
  unique: true,
  where: `"status" = 'mounted'`,
})
export class Tire {
  @PrimaryGeneratedColumn('uuid', { name: 'tire_id' })
  tireId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({ name: 'serial_number', type: 'varchar', length: 60 })
  serialNumber!: string;

  @Column({ name: 'brand', type: 'varchar', length: 60 })
  brand!: string;

  @Column({ name: 'size', type: 'varchar', length: 40 })
  size!: string;

  @Column({
    name: 'cost',
    type: 'decimal',
    precision: 12,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  cost!: number;

  /** Salida de la caja con que se pagó la compra (`null` mientras esté sin pagar). */
  @ForeignKey('cash_movement', {
    name: 'FK_tire_cash_movement',
    onDelete: 'RESTRICT',
  })
  @Column({ name: 'cash_movement_id', type: 'uuid', nullable: true })
  cashMovementId!: string | null;

  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt!: Date | null;

  @Column({
    name: 'status',
    type: 'enum',
    enum: TireStatus,
    default: TireStatus.IN_STOCK,
  })
  status!: TireStatus;

  @ManyToOne(() => Car, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'car_id' })
  car?: Car | null;

  @Column({ name: 'car_id', type: 'uuid', nullable: true })
  carId!: string | null;

  /** Código corto de la posición en el vehículo (p. ej. DI = delantero izquierdo). */
  @Column({ name: 'position', type: 'varchar', length: 6, nullable: true })
  position!: string | null;

  /** Kilometraje del vehículo en el montaje vigente. */
  @Column({ name: 'mounted_odometer_km', type: 'integer', nullable: true })
  mountedOdometerKm!: number | null;

  /** Km recorridos en los montajes ya cerrados (desmontaje, baja). */
  @Column({ name: 'km_traveled', type: 'integer', default: 0 })
  kmTraveled!: number;

  @Column({ name: 'retread_count', type: 'integer', default: 0 })
  retreadCount!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
