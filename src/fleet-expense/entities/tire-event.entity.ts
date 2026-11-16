import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { Car } from '../../car/entities/car.entity';
import { User } from '../../users/entities/user.entity';
import { Tire } from './tire.entity';

export enum TireEventType {
  MOUNT = 'mount',
  UNMOUNT = 'unmount',
  ROTATE = 'rotate',
  RETREAD = 'retread',
  RETIRE = 'retire',
}

/** Movimiento de un neumático (CU-206). Es un asiento: sólo se agrega, nunca se modifica. */
@Entity('tire_event')
@Index('IDX_tire_event_tire', ['tireId', 'createdAt'])
export class TireEvent {
  @PrimaryGeneratedColumn('uuid', { name: 'event_id' })
  eventId!: string;

  @ManyToOne(() => Tire, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tire_id' })
  tire?: Tire;

  @Column({ name: 'tire_id', type: 'uuid' })
  tireId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({
    name: 'type',
    type: 'enum',
    enum: TireEventType,
  })
  type!: TireEventType;

  /** Vehículo del movimiento (el del montaje, el del que se desmonta o rota). */
  @ManyToOne(() => Car, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'car_id' })
  car?: Car | null;

  @Column({ name: 'car_id', type: 'uuid', nullable: true })
  carId!: string | null;

  @Column({ name: 'position', type: 'varchar', length: 6, nullable: true })
  position!: string | null;

  @Column({ name: 'odometer_km', type: 'integer' })
  odometerKm!: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'created_by_user_id' })
  createdBy?: User;

  @Column({ name: 'created_by_user_id', type: 'uuid' })
  createdByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
