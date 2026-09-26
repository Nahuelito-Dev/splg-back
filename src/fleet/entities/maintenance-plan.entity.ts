import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';

export enum MaintenanceSubject {
  VEHICLE = 'vehicle',
  DRIVER = 'driver',
}

export enum MaintenanceTrigger {
  BY_KM = 'by_km',
  BY_TIME = 'by_time',
  BY_FIXED_DATE = 'by_fixed_date',
}

export enum MaintenanceCriticality {
  BLOCKING = 'blocking',
  NON_BLOCKING = 'non_blocking',
}

/**
 * Plan de mantenimiento
 * La regla: qué se controla, cada cuánto, con qué anticipación y si inhabilita.
 * Casos: CU-136 a CU-142 y CU-105 (M1)
 */
@Entity('maintenance_plan')
export class MaintenancePlan {
  @PrimaryGeneratedColumn('uuid', { name: 'plan_id' })
  planId!: string;

  @Index()
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor!: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({ name: 'name', type: 'varchar', length: 120, nullable: false })
  name!: string;

  @Column({
    name: 'subject',
    type: 'enum',
    enum: MaintenanceSubject,
    enumName: 'maintenance_subject_enum',
    nullable: false,
  })
  subject!: MaintenanceSubject;

  @Column({
    name: 'trigger',
    type: 'enum',
    enum: MaintenanceTrigger,
    enumName: 'maintenance_trigger_enum',
    nullable: false,
  })
  trigger!: MaintenanceTrigger;

  @Column({ name: 'interval_km', type: 'integer', nullable: true })
  intervalKm!: number | null;

  @Column({ name: 'interval_months', type: 'integer', nullable: true })
  intervalMonths!: number | null;

  @Column({ name: 'lead_time_days', type: 'integer', nullable: false })
  leadTimeDays!: number;

  @Column({
    name: 'criticality',
    type: 'enum',
    enum: MaintenanceCriticality,
    enumName: 'maintenance_criticality_enum',
    nullable: false,
  })
  criticality!: MaintenanceCriticality;

  @Column({ name: 'car_type', type: 'varchar', nullable: true })
  carType!: string | null;

  @Column({
    name: 'is_active',
    type: 'boolean',
    nullable: false,
    default: true,
  })
  isActive!: boolean;
}
