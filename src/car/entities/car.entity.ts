// src/car/entities/car.entity.ts - VERSIÓN MEJORADA
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  DeleteDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';

export enum FleetStatus {
  ACTIVE = 'active',
  IN_SERVICE = 'in_service',
  GROUNDED = 'grounded',
}

@Entity('car')
export class Car {
  @PrimaryGeneratedColumn('uuid', { name: 'car_id' })
  carId!: string;

  /** Tenant dueño del vehículo. Nullable hasta backfill del seed. */
  @Index()
  @ManyToOne(() => Distributor, { nullable: false })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({
    name: 'distributor_id',
    type: 'uuid',
    nullable: false,
  })
  distributorId!: string;

  @ManyToOne(() => User, (user) => user.cars, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({
    name: 'user_id',
    type: 'uuid',
  })
  userId!: string;

  @Column({
    name: 'type_car',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  typeCar!: string | null; // Ej: 'Moto', 'Auto', 'Camioneta'

  @Column({
    name: 'car_capacity',
    type: 'int',
    nullable: true,
  })
  carCapacity!: number | null; // Capacidad en kg

  // Única entre los vehículos vigentes: dar de baja uno no bloquea volver a
  // registrar la misma patente.
  @Index('UQ_car_patente_vigente', ['car_patent'], {
    unique: true,
    where: '"deletedAt" IS NULL',
  })
  @Column({
    name: 'car_patent',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  carPatent!: string | null;

  @Column({
    name: 'car_brand',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  carBrand!: string | null; // Marca

  @Column({
    name: 'car_model',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  carModel!: string | null; // Modelo

  @Column({
    name: 'car_year',
    type: 'int',
    nullable: true,
  })
  carYear!: number | null; // Año

  @Column({
    name: 'car_color',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  carColor!: string | null; // Color

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  /** Baja lógica: la fila se conserva para el historial y la auditoría. */
  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @Column({
    name: 'tare_weight_kg',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
    nullable: true,
  })
  tareWeightKg!: number | null;

  @Column({
    name: 'max_load_kg',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
    nullable: true,
  })
  maxLoadKg!: number | null;

  @Column({ name: 'odometer_km', type: 'integer', nullable: true })
  odometerKm!: number | null;

  @Column({
    name: 'fleet_status',
    type: 'enum',
    enum: FleetStatus,
    enumName: 'fleet_status_enum',
    nullable: false,
    default: FleetStatus.ACTIVE,
  })
  fleetStatus!: FleetStatus;

  @Column({ name: 'in_service_since', type: 'timestamptz', nullable: true })
  inServiceSince!: Date | null;
}
