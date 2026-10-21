import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
  Check,
} from 'typeorm';
import type { Point } from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { Car } from '../../car/entities/car.entity';
import { Employee } from '../../employee/entities/employee.entity';
import { User } from '../../users/entities/user.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';

/** Ciclo del siniestro: denunciado, en revisión, en reparación y cerrado. */
export enum VehicleAccidentStatus {
  REPORTED = 'reported',
  UNDER_REVIEW = 'under_review',
  REPAIRING = 'repairing',
  CLOSED = 'closed',
}

/**
 * Siniestro de un vehículo (CU-201, CU-202, CU-327, CU-328). No es la
 * incidencia de un pedido (CU-060): es un hecho del vehículo, con su costo.
 */
@Check(
  'CHK_vehicle_accident_montos',
  `coalesce("repair_cost", 0) >= 0 AND coalesce("insurer_reimbursement", 0) >= 0 AND coalesce("deductible_amount", 0) >= 0 AND ("insurer_reimbursement" IS NULL OR "repair_cost" IS NULL OR "insurer_reimbursement" <= "repair_cost")`,
)
@Check(
  'CHK_vehicle_accident_cerrado_fecha',
  `"status" <> 'closed' OR "closed_at" IS NOT NULL`,
)
@Entity('vehicle_accident')
@Index('IDX_vehicle_accident_car', ['carId', 'occurredAt'])
@Index('IDX_vehicle_accident_status', ['distributorId', 'status'])
export class VehicleAccident {
  @PrimaryGeneratedColumn('uuid', { name: 'accident_id' })
  accidentId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @ManyToOne(() => Car, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'car_id' })
  car?: Car;

  @Column({ name: 'car_id', type: 'uuid' })
  carId!: string;

  /** Quien conducía, si se lo identifica. */
  @ManyToOne(() => Employee, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'employee_id' })
  employee?: Employee | null;

  @Column({ name: 'employee_id', type: 'uuid', nullable: true })
  employeeId!: string | null;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;

  @Column({
    name: 'location',
    type: 'geometry',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  location!: Point | null;

  @Column({ name: 'address', type: 'text', nullable: true })
  address!: string | null;

  @Column({ name: 'description', type: 'text' })
  description!: string;

  @Column({ name: 'injuries', type: 'boolean', default: false })
  injuries!: boolean;

  @Column({ name: 'third_parties_involved', type: 'boolean', default: false })
  thirdPartiesInvolved!: boolean;

  /** Fuga o derrame de gas: obliga a avisar de inmediato a los administradores. */
  @Column({ name: 'hazmat_release', type: 'boolean', default: false })
  hazmatRelease!: boolean;

  @Column({
    name: 'police_report_number',
    type: 'varchar',
    length: 40,
    nullable: true,
  })
  policeReportNumber!: string | null;

  @Column({
    name: 'insurer_claim_number',
    type: 'varchar',
    length: 40,
    nullable: true,
  })
  insurerClaimNumber!: string | null;

  @Column({
    name: 'status',
    type: 'enum',
    enum: VehicleAccidentStatus,
    default: VehicleAccidentStatus.REPORTED,
  })
  status!: VehicleAccidentStatus;

  /** Si quedó inutilizable, el vehículo pasó a fuera de servicio al registrarlo. */
  @Column({ name: 'vehicle_unusable', type: 'boolean', default: false })
  vehicleUnusable!: boolean;

  @Column({
    name: 'repair_cost',
    type: 'decimal',
    precision: 12,
    scale: 2,
    transformer: columnNumericTransformer,
    nullable: true,
  })
  repairCost!: number | null;

  @Column({
    name: 'insurer_reimbursement',
    type: 'decimal',
    precision: 12,
    scale: 2,
    transformer: columnNumericTransformer,
    nullable: true,
  })
  insurerReimbursement!: number | null;

  @Column({
    name: 'deductible_amount',
    type: 'decimal',
    precision: 12,
    scale: 2,
    transformer: columnNumericTransformer,
    nullable: true,
  })
  deductibleAmount!: number | null;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'created_by_user_id' })
  createdBy?: User;

  @Column({ name: 'created_by_user_id', type: 'uuid' })
  createdByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
