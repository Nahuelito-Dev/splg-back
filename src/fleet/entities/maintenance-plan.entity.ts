import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { JobPositionCategory } from '../../employee/entities/job-position.entity';

export enum MaintenanceSubject {
  VEHICLE = 'vehicle',
  /** Histórico: la licencia de conducir cuelga del perfil de reparto (`delivery_id`). */
  DRIVER = 'driver',
  /** Documentación del personal (CU-183 a CU-185): la tarea cuelga del legajo. */
  EMPLOYEE = 'employee',
}

/** Qué formulario muestra el panel y qué forma de `details` valida el back. */
export enum MaintenanceDocumentKind {
  INSURANCE = 'insurance',
  VTV = 'vtv',
  HAZMAT_VEHICLE_PERMIT = 'hazmat_vehicle_permit',
  DRIVER_LICENSE = 'driver_license',
  HAZMAT_DRIVER_COURSE = 'hazmat_driver_course',
  PSYCHOPHYSICAL = 'psychophysical',
  ART_COVERAGE = 'art_coverage',
  SERVICE = 'service',
  GENERIC = 'generic',
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
 * Qué documento es, para los planes que el sistema necesita reconocer (el
 * costo del vehículo prorratea el seguro; CU-197 es la habilitación de
 * mercancías peligrosas). `null` en los planes que cada distribuidora arma.
 */
/**
 * Plan de mantenimiento
 * La regla: qué se controla, cada cuánto, con qué anticipación y si inhabilita.
 * Casos: CU-136 a CU-142, CU-183 a CU-185 y CU-105 (M1)
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
    name: 'document_kind',
    type: 'enum',
    enum: MaintenanceDocumentKind,
    enumName: 'plan_document_kind_enum',
    nullable: true,
  })
  documentKind!: MaintenanceDocumentKind | null;

  /**
   * Categorías de puesto a las que aplica un plan de personal (CU-183 a
   * CU-185). `null` = a todas.
   */
  @Column({
    name: 'applies_to_categories',
    type: 'varchar',
    array: true,
    nullable: true,
  })
  appliesToCategories!: JobPositionCategory[] | null;

  @Column({
    name: 'is_active',
    type: 'boolean',
    nullable: false,
    default: true,
  })
  isActive!: boolean;
}
