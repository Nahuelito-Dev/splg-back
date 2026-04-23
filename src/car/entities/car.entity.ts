// src/car/entities/car.entity.ts - VERSIÓN MEJORADA
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity('car')
export class Car {
  @PrimaryGeneratedColumn('uuid', { name: 'car_id' })
  car_id: string;

  @ManyToOne(() => User, (user) => user.cars, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'uuid' })
  user_id: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  type_car?: string; // Ej: 'Moto', 'Auto', 'Camioneta'

  @Column({ type: 'int', nullable: true })
  car_capacity?: number; // Capacidad en kg

  @Column({ type: 'varchar', length: 20, nullable: true, unique: true })
  car_patent?: string; // Patente única

  @Column({ type: 'varchar', length: 50, nullable: true })
  car_brand?: string; // Marca

  @Column({ type: 'varchar', length: 50, nullable: true })
  car_model?: string; // Modelo

  @Column({ type: 'int', nullable: true })
  car_year?: number; // Año

  @Column({ type: 'varchar', length: 50, nullable: true })
  car_color?: string; // Color

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
