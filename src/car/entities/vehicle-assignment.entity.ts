import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  Check,
  Exclusion,
} from 'typeorm';
import { Car } from './car.entity';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Qué chofer está usando qué vehículo, con historial. La flota es de la
 * distribuidora: cualquier chofer puede usar cualquiera de sus vehículos, y
 * `car.user_id` queda como "chofer habitual" (informativo, no se toca) — el
 * vehículo EN USO de verdad es el de la asignación abierta (`released_at
 * IS NULL`) de esta tabla.
 *
 * `released_at IS NULL` = en uso. Los dos índices únicos parciales son la
 * invariante del negocio a nivel de base (no sólo en el service): un
 * vehículo no puede estar en uso por dos choferes a la vez, ni un chofer
 * puede tener dos vehículos en uso a la vez.
 */
@Check(
  'CHK_vehicle_assignment_periodo',
  `"released_at" IS NULL OR "released_at" >= "assigned_at"`,
)
@Exclusion(
  'EXC_vehicle_assignment_vehiculo_solapada',
  `USING gist ("car_id" WITH =, tstzrange("assigned_at", COALESCE("released_at", 'infinity'::timestamptz)) WITH &&)`,
)
@Exclusion(
  'EXC_vehicle_assignment_chofer_solapada',
  `USING gist ("delivery_id" WITH =, tstzrange("assigned_at", COALESCE("released_at", 'infinity'::timestamptz)) WITH &&)`,
)
@Entity('vehicle_assignment')
@Index('UQ_vehicle_assignment_car_abierta', ['carId'], {
  unique: true,
  where: '"released_at" IS NULL',
})
@Index('UQ_vehicle_assignment_delivery_abierta', ['deliveryId'], {
  unique: true,
  where: '"released_at" IS NULL',
})
export class VehicleAssignment {
  @PrimaryGeneratedColumn('uuid', { name: 'assignment_id' })
  assignmentId!: string;

  @Index()
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor!: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @ManyToOne(() => Car, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'car_id' })
  car!: Car;

  @Column({ name: 'car_id', type: 'uuid' })
  carId!: string;

  @ManyToOne(() => Delivery, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'delivery_id' })
  delivery!: Delivery;

  @Column({ name: 'delivery_id', type: 'uuid' })
  deliveryId!: string;

  @Column({ name: 'assigned_at', type: 'timestamptz' })
  assignedAt!: Date;

  /** `null` = todavía en uso. Se setea al liberar (manual, reasignación o baja del chofer). */
  @Column({ name: 'released_at', type: 'timestamptz', nullable: true })
  releasedAt!: Date | null;

  // `null` sólo en las filas del backfill inicial (migración
  // `BackfillVehiculoEnUsoInicial`): no hubo un admin que las haya creado,
  // el sistema las infirió de `car.user_id`.
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'assigned_by_user_id' })
  assignedBy!: User | null;

  @Column({ name: 'assigned_by_user_id', type: 'uuid', nullable: true })
  assignedByUserId!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'released_by_user_id' })
  releasedBy!: User | null;

  @Column({ name: 'released_by_user_id', type: 'uuid', nullable: true })
  releasedByUserId!: string | null;

  @Column({ name: 'note', type: 'text', nullable: true })
  note!: string | null;
}
