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
  car_id!: string;

  /** Tenant dueño del vehículo. Nullable hasta backfill del seed. */
  @Index()
  @ManyToOne(() => Distributor, { nullable: false })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ type: 'uuid', nullable: false })
  distributor_id!: string;

  @ManyToOne(() => User, (user) => user.cars, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  type_car!: string | null; // Ej: 'Moto', 'Auto', 'Camioneta'

  @Column({ type: 'int', nullable: true })
  car_capacity!: number | null; // Capacidad en kg

  // Única entre los vehículos vigentes: dar de baja uno no bloquea volver a
  // registrar la misma patente.
  @Index('UQ_car_patente_vigente', ['car_patent'], {
    unique: true,
    where: '"deletedAt" IS NULL',
  })
  @Column({ type: 'varchar', length: 20, nullable: true })
  car_patent!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  car_brand!: string | null; // Marca

  @Column({ type: 'varchar', length: 50, nullable: true })
  car_model!: string | null; // Modelo

  @Column({ type: 'int', nullable: true })
  car_year!: number | null; // Año

  @Column({ type: 'varchar', length: 50, nullable: true })
  car_color!: string | null; // Color

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
  tare_weight_kg!: number | null;

  @Column({
    name: 'max_load_kg',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
    nullable: true,
  })
  max_load_kg!: number | null;

  @Column({ name: 'odometer_km', type: 'integer', nullable: true })
  odometer_km!: number | null;

  @Column({
    name: 'fleet_status',
    type: 'enum',
    enum: FleetStatus,
    enumName: 'fleet_status_enum',
    nullable: false,
    default: FleetStatus.ACTIVE,
  })
  fleet_status!: FleetStatus;

  @Column({ name: 'in_service_since', type: 'timestamptz', nullable: true })
  in_service_since!: Date | null;
}
