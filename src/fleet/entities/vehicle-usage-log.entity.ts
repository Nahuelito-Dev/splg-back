import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
  Check,
} from 'typeorm';
import { Car } from '../../car/entities/car.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';

/**
 * Registro de uso del vehículo
 * Kilómetros, pedidos y horas en ruta por vehículo y día. Sólo se agrega.
 * Casos: CU-136 a CU-142 y CU-105 (M1)
 */
@Check(
  'CHK_vehicle_usage_log_valores',
  `"km" >= 0 AND "orders" >= 0 AND "route_hours" >= 0`,
)
@Entity('vehicle_usage_log')
@Unique('UQ_vehicle_usage_log_car_day', ['carId', 'day'])
export class VehicleUsageLog {
  @PrimaryGeneratedColumn('uuid', { name: 'log_id' })
  logId!: string;

  @ManyToOne(() => Car, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'car_id' })
  car!: Car;

  @Column({ name: 'car_id', type: 'uuid' })
  carId!: string;

  @Index()
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor!: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({ name: 'day', type: 'date', nullable: false })
  day!: string;

  @Column({
    name: 'km',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
    nullable: false,
  })
  km!: number;

  @Column({ name: 'orders', type: 'integer', nullable: false, default: 0 })
  orders!: number;

  @Column({
    name: 'route_hours',
    type: 'decimal',
    precision: 6,
    scale: 2,
    transformer: columnNumericTransformer,
    nullable: false,
    default: 0,
  })
  routeHours!: number;
}
