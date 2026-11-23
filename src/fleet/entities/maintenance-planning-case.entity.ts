import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
  Check,
} from 'typeorm';
import { MaintenanceTask } from './maintenance-task.entity';
import type { MaintenanceWindowProposal } from './maintenance-window-proposal.entity';
import { Car } from '../../car/entities/car.entity';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';

export enum PlanningCaseStatus {
  /** Se le ofrece una ventana por vez al chofer. */
  NEGOTIATING = 'negotiating',
  /** Hay una ventana acordada con el chofer: falta que el administrador confirme el taller y el gasto. */
  AWAITING_CONFIRMATION = 'awaiting_confirmation',
  /** No hubo acuerdo (o no hay con quién negociar): lo resuelve el administrador. */
  ESCALATED = 'escalated',
  CONFIRMED = 'confirmed',
  CANCELLED = 'cancelled',
}

export enum PlanningEscalationReason {
  NO_DRIVER = 'no_driver',
  COVERAGE = 'coverage',
  EXHAUSTED = 'exhausted',
  NO_WINDOWS = 'no_windows',
}

export enum PlanningWindowSource {
  DRIVER_ACCEPTED = 'driver_accepted',
  DRIVER_ALTERNATIVE = 'driver_alternative',
  ADMIN = 'admin',
}

/** Una ventana evaluada por el planificador, con el motivo de descarte si no pasó. */
export interface EvaluatedWindow {
  start: string;
  end: string;
  /** Pedidos esperados ese día en la zona del vehículo. */
  demand: number;
  /** Vehículos que quedarían activos en la zona con el vehículo en el taller. */
  unitsLeft: number | null;
  /** Después del vencimiento proyectado: se ofrece lo antes posible. */
  urgent: boolean;
  offered: boolean;
  /** `rejected` y `expired`: se ofreció al chofer y no la tomó. */
  discardReason: 'coverage' | 'not_selected' | 'rejected' | 'expired' | null;
}

/**
 * Caso de planificación del mantenimiento
 * La negociación de la ventana de taller de una tarea: qué se evaluó, qué se
 * le ofreció al chofer y cómo terminó. Una tarea tiene a lo sumo un caso abierto.
 * Casos: CU-105 (M2)
 */
@Check(
  'CHK_planning_case_ventana',
  `("chosen_start" IS NULL) = ("chosen_end" IS NULL) AND ("chosen_start" IS NULL OR "chosen_end" > "chosen_start")`,
)
@Check(
  'CHK_planning_case_estado',
  `("status" <> 'escalated' OR ("escalated_at" IS NOT NULL AND "escalation_reason" IS NOT NULL)) AND ("status" NOT IN ('awaiting_confirmation', 'confirmed') OR ("chosen_start" IS NOT NULL AND "chosen_source" IS NOT NULL)) AND ("status" NOT IN ('confirmed', 'cancelled') OR "resolved_at" IS NOT NULL)`,
)
@Index('UQ_planning_case_tarea_abierto', ['taskId'], {
  unique: true,
  where: `"status" IN ('negotiating', 'awaiting_confirmation', 'escalated')`,
})
@Index('IDX_planning_case_distribuidora_estado', ['distributorId', 'status'])
@Entity('maintenance_planning_case')
export class MaintenancePlanningCase {
  @PrimaryGeneratedColumn('uuid', { name: 'case_id' })
  caseId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor!: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @ManyToOne(() => MaintenanceTask, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'task_id' })
  task!: MaintenanceTask;

  @Column({ name: 'task_id', type: 'uuid' })
  taskId!: string;

  @ManyToOne(() => Car, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'car_id' })
  car!: Car;

  @Column({ name: 'car_id', type: 'uuid' })
  carId!: string;

  /** Chofer con quien se negocia; `null` si el vehículo no tenía chofer asignado. */
  @ManyToOne(() => Delivery, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'delivery_id' })
  delivery!: Delivery | null;

  @Column({ name: 'delivery_id', type: 'uuid', nullable: true })
  deliveryId!: string | null;

  @Column({
    name: 'status',
    type: 'enum',
    enum: PlanningCaseStatus,
    enumName: 'planning_case_status_enum',
    nullable: false,
    default: PlanningCaseStatus.NEGOTIATING,
  })
  status!: PlanningCaseStatus;

  /** Fecha proyectada del vencimiento con la que se planificó. */
  @Column({ name: 'projected_due_at', type: 'timestamptz', nullable: false })
  projectedDueAt!: Date;

  /** El cuadro del paso 10: todas las ventanas evaluadas y por qué se descartó cada una. */
  @Column({ name: 'evaluated_windows', type: 'jsonb', nullable: false })
  evaluatedWindows!: EvaluatedWindow[];

  @Column({
    name: 'escalation_reason',
    type: 'enum',
    enum: PlanningEscalationReason,
    enumName: 'planning_escalation_reason_enum',
    nullable: true,
  })
  escalationReason!: PlanningEscalationReason | null;

  @Column({ name: 'opened_at', type: 'timestamptz', nullable: false })
  openedAt!: Date;

  @Column({ name: 'escalated_at', type: 'timestamptz', nullable: true })
  escalatedAt!: Date | null;

  @Column({ name: 'chosen_start', type: 'timestamptz', nullable: true })
  chosenStart!: Date | null;

  @Column({ name: 'chosen_end', type: 'timestamptz', nullable: true })
  chosenEnd!: Date | null;

  @Column({
    name: 'chosen_source',
    type: 'enum',
    enum: PlanningWindowSource,
    enumName: 'planning_window_source_enum',
    nullable: true,
  })
  chosenSource!: PlanningWindowSource | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'resolved_by_user_id' })
  resolvedBy!: User | null;

  @Column({ name: 'resolved_by_user_id', type: 'uuid', nullable: true })
  resolvedByUserId!: string | null;

  @Column({ name: 'notes', type: 'text', nullable: true })
  notes!: string | null;

  @OneToMany('MaintenanceWindowProposal', 'planningCase')
  proposals?: MaintenanceWindowProposal[];
}
