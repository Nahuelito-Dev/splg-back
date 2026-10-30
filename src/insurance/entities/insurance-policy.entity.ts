import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Exclusion,
  ForeignKey,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Car } from '../../car/entities/car.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { Insurer } from './insurer.entity';
import { InsuranceInstallment } from './insurance-installment.entity';

/**
 * Póliza de seguro de un vehículo. Renovar es dar de alta otra póliza: la
 * anterior queda como historial. Un vehículo no tiene dos pólizas no
 * canceladas con vigencias solapadas (la base lo exige con
 * `EXC_insurance_policy_solapada`; la vigencia es `[validFrom, validTo)`, así
 * que la renovación puede empezar el día en que vence la anterior).
 * Cancelarla es una baja lógica con motivo.
 */
@Check('CHK_insurance_policy_vigencia', `"valid_to" > "valid_from"`)
@Check(
  'CHK_insurance_policy_cancelada',
  `("cancelled_at" IS NULL AND "cancel_reason" IS NULL) OR ("cancelled_at" IS NOT NULL AND btrim(coalesce("cancel_reason", '')) <> '')`,
)
@Check(
  'CHK_insurance_policy_textos',
  `char_length(btrim("policy_number")) >= 1 AND char_length(btrim("coverage")) >= 1`,
)
@ForeignKey(
  () => Car,
  ['car_id', 'distributor_id'],
  ['car_id', 'distributor_id'],
  { name: 'FK_insurance_policy_car_distribuidora', onDelete: 'NO ACTION' },
)
@ForeignKey(
  () => Insurer,
  ['insurer_id', 'distributor_id'],
  ['insurer_id', 'distributor_id'],
  {
    name: 'FK_insurance_policy_insurer_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Unique('UQ_insurance_policy_id_distribuidora', ['policyId', 'distributorId'])
@Exclusion(
  'EXC_insurance_policy_solapada',
  `USING gist ("car_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&) WHERE ("cancelled_at" IS NULL)`,
)
@Entity('insurance_policy')
@Index(
  'UQ_insurance_policy_numero_vigente',
  ['distributorId', 'insurerId', 'policyNumber'],
  { unique: true, where: '"cancelled_at" IS NULL' },
)
@Index('IDX_insurance_policy_car', ['carId', 'validFrom'])
export class InsurancePolicy {
  @PrimaryGeneratedColumn('uuid', { name: 'policy_id' })
  policyId!: string;

  @Index('IDX_insurance_policy_distributor')
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @ManyToOne(() => Car, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'car_id' })
  car?: Car;

  @Column({ name: 'car_id', type: 'uuid' })
  carId!: string;

  @ManyToOne(() => Insurer, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'insurer_id' })
  insurer?: Insurer;

  @Column({ name: 'insurer_id', type: 'uuid' })
  insurerId!: string;

  @Column({ name: 'policy_number', type: 'varchar', length: 40 })
  policyNumber!: string;

  @Column({ name: 'coverage', type: 'text' })
  coverage!: string;

  /** Fecha de calendario `YYYY-MM-DD`: desde ese día, inclusive. */
  @Column({ name: 'valid_from', type: 'date' })
  validFrom!: string;

  /** Fecha de calendario `YYYY-MM-DD`: la póliza vence ese día. */
  @Column({ name: 'valid_to', type: 'date' })
  validTo!: string;

  /** Código de pago electrónico (Pago Fácil, Rapipago). */
  @Column({ name: 'payment_code', type: 'varchar', length: 60, nullable: true })
  paymentCode!: string | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @Column({ name: 'cancel_reason', type: 'text', nullable: true })
  cancelReason!: string | null;

  /** La tarea de seguro de flota que creó esta póliza, para revertirla al cancelarla. */
  @ForeignKey('maintenance_task', {
    name: 'FK_insurance_policy_fleet_task',
    onDelete: 'SET NULL',
  })
  @Column({ name: 'fleet_task_id', type: 'uuid', nullable: true })
  fleetTaskId!: string | null;

  /** Las tareas de seguro que esta póliza dio por hechas, con el estado en que estaban. */
  @Column({
    name: 'fleet_closed_tasks',
    type: 'jsonb',
    default: () => `'[]'`,
  })
  fleetClosedTasks!: Array<{ taskId: string; status: string }>;

  /** La póliza empieza después de que vence el seguro de flota: el cron la sincroniza cuando empiece. */
  @Column({ name: 'fleet_pending', type: 'boolean', default: false })
  fleetPending!: boolean;

  @OneToMany(() => InsuranceInstallment, (c) => c.policy)
  installments?: InsuranceInstallment[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
