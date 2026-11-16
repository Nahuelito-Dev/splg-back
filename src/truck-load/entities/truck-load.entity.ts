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
  ForeignKey,
  Unique,
} from 'typeorm';
import { Car } from '../../car/entities/car.entity';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { Employee } from '../../employee/entities/employee.entity';
import { StockLocation } from '../../stock/entities/stock-location.entity';
import { User } from '../../users/entities/user.entity';
import { TruckLoadStatus } from '../domain/truck-load.enums';
import { TruckLoadItem } from './truck-load-item.entity';

/**
 * Hoja de carga del camión: lo que sale del depósito con un chofer, lo que se
 * repone en ruta y la rendición al volver. Un camión y un chofer tienen una
 * sola carga abierta (`loading`, `on_route`, `returned`), garantizado por los
 * dos únicos parciales. El stock se mueve por el libro (`reference_id` =
 * `load_id` en `stock_movement`); acá sólo se guarda el documento.
 */
@Check(
  'CHK_truck_load_salida',
  `"status" IN ('loading', 'cancelled') OR "departed_at" IS NOT NULL`,
)
@Check(
  'CHK_truck_load_regreso',
  `"status" NOT IN ('returned', 'closed', 'closed_with_difference') OR "returned_at" IS NOT NULL`,
)
@Check(
  'CHK_truck_load_cierre',
  `"status" NOT IN ('closed', 'closed_with_difference', 'cancelled') OR "closed_at" IS NOT NULL`,
)
@Check(
  'CHK_truck_load_cancelada',
  `"status" <> 'cancelled' OR "cancel_reason" IS NOT NULL`,
)
@ForeignKey(
  () => StockLocation,
  ['origin_location_id', 'distributor_id'],
  ['location_id', 'distributor_id'],
  {
    name: 'FK_truck_load_origin_location_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@ForeignKey(
  () => Car,
  ['car_id', 'distributor_id'],
  ['car_id', 'distributor_id'],
  { name: 'FK_truck_load_car_distribuidora', onDelete: 'NO ACTION' },
)
@ForeignKey(
  () => Delivery,
  ['delivery_id', 'distributor_id'],
  ['delivery_id', 'distributor_id'],
  { name: 'FK_truck_load_delivery_distribuidora', onDelete: 'NO ACTION' },
)
@ForeignKey(
  () => Employee,
  ['helper_employee_id', 'distributor_id'],
  ['employee_id', 'distributor_id'],
  {
    name: 'FK_truck_load_helper_employee_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Unique('UQ_truck_load_id_distribuidora', ['loadId', 'distributorId'])
@Entity('truck_load')
@Index('UQ_truck_load_numero', ['distributorId', 'number'], { unique: true })
@Index('UQ_truck_load_camion_abierta', ['carId'], {
  unique: true,
  where: `"status" IN ('loading', 'on_route', 'returned')`,
})
@Index('UQ_truck_load_chofer_abierta', ['deliveryId'], {
  unique: true,
  where: `"status" IN ('loading', 'on_route', 'returned')`,
})
@Index('IDX_truck_load_fecha', ['distributorId', 'businessDate'])
@Index('IDX_truck_load_estado', ['distributorId', 'status'])
export class TruckLoad {
  @PrimaryGeneratedColumn('uuid', { name: 'load_id' })
  loadId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  /** Número correlativo por distribuidora (`document_sequence`). */
  @Column({ type: 'int' })
  number!: number;

  @Index('IDX_truck_load_camion')
  @ManyToOne(() => Car, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'car_id' })
  car?: Car;

  @Column({ name: 'car_id', type: 'uuid' })
  carId!: string;

  @Index('IDX_truck_load_chofer')
  @ManyToOne(() => Delivery, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'delivery_id' })
  delivery?: Delivery;

  @Column({ name: 'delivery_id', type: 'uuid' })
  deliveryId!: string;

  @ManyToOne(() => Employee, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'helper_employee_id' })
  helper?: Employee | null;

  @Column({ name: 'helper_employee_id', type: 'uuid', nullable: true })
  helperEmployeeId!: string | null;

  /** Ubicación (depósito) de la que sale la carga y a la que vuelve. */
  @ManyToOne(() => StockLocation, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'origin_location_id' })
  originLocation?: StockLocation;

  @Column({ name: 'origin_location_id', type: 'uuid' })
  originLocationId!: string;

  /** Día de negocio en hora argentina (YYYY-MM-DD). */
  @Column({ name: 'business_date', type: 'date' })
  businessDate!: string;

  @Column({
    type: 'enum',
    enum: TruckLoadStatus,
    default: TruckLoadStatus.LOADING,
  })
  status!: TruckLoadStatus;

  @Column({ name: 'opened_at', type: 'timestamptz', default: () => 'now()' })
  openedAt!: Date;

  @Column({ name: 'departed_at', type: 'timestamptz', nullable: true })
  departedAt!: Date | null;

  @Column({ name: 'returned_at', type: 'timestamptz', nullable: true })
  returnedAt!: Date | null;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'opened_by_user_id' })
  openedBy?: User;

  @Column({ name: 'opened_by_user_id', type: 'uuid' })
  openedByUserId!: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'closed_by_user_id' })
  closedBy?: User | null;

  @Column({ name: 'closed_by_user_id', type: 'uuid', nullable: true })
  closedByUserId!: string | null;

  /** Obligatoria si la rendición cierra con diferencia. */
  @Column({ name: 'difference_note', type: 'text', nullable: true })
  differenceNote!: string | null;

  @Column({ name: 'cancel_reason', type: 'text', nullable: true })
  cancelReason!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @OneToMany(() => TruckLoadItem, (i) => i.load)
  items?: TruckLoadItem[];

  /** Key de la foto principal en el bucket (`truck-loads/{distribuidora}/{id}/{uuid}.{ext}`). */
  @Column({ name: 'photo_key', type: 'varchar', length: 512, nullable: true })
  photoKey!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
