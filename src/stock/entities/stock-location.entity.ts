import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  ForeignKey,
  Unique,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { Car } from '../../car/entities/car.entity';
import { StockLocationKind } from '../domain/stock.enums';
import { Warehouse } from './warehouse.entity';

/**
 * Dónde puede haber garrafas: un depósito o un vehículo. Existe para que los
 * saldos y los movimientos tengan UNA clave foránea de ubicación en vez de dos
 * columnas en cada tabla. Se crea junto con el depósito y, para un vehículo,
 * la primera vez que recibe stock.
 */
@ForeignKey(
  () => Warehouse,
  ['warehouse_id', 'distributor_id'],
  ['warehouse_id', 'distributor_id'],
  {
    name: 'FK_stock_location_warehouse_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@ForeignKey(
  () => Car,
  ['car_id', 'distributor_id'],
  ['car_id', 'distributor_id'],
  { name: 'FK_stock_location_car_distribuidora', onDelete: 'NO ACTION' },
)
@Unique('UQ_stock_location_id_distribuidora', ['locationId', 'distributorId'])
@Entity('stock_location')
@Index('UQ_stock_location_warehouse', ['warehouseId'], { unique: true })
@Index('UQ_stock_location_car', ['carId'], { unique: true })
@Check(
  'CHK_stock_location_one_owner',
  'num_nonnulls("warehouse_id", "car_id") = 1',
)
@Check(
  'CHK_stock_location_kind',
  '("kind" = \'warehouse\') = ("warehouse_id" IS NOT NULL)',
)
export class StockLocation {
  @PrimaryGeneratedColumn('uuid', { name: 'location_id' })
  locationId!: string;

  @Index('IDX_stock_location_distributor')
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({ type: 'enum', enum: StockLocationKind })
  kind!: StockLocationKind;

  @ManyToOne(() => Warehouse, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'warehouse_id' })
  warehouse?: Warehouse | null;

  @Column({ name: 'warehouse_id', type: 'uuid', nullable: true })
  warehouseId!: string | null;

  @ManyToOne(() => Car, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'car_id' })
  car?: Car | null;

  @Column({ name: 'car_id', type: 'uuid', nullable: true })
  carId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
