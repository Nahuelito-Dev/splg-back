import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Check,
  Unique,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';

/**
 * `open`: antes del cierre, el panel arma a mano. `proposed`: corrió la
 * propuesta del sistema (se puede re-proponer). `closed`: el administrador
 * cerró el día.
 */
export enum RoutePlanStatus {
  OPEN = 'open',
  PROPOSED = 'proposed',
  CLOSED = 'closed',
}

/** Resumen de la última corrida de la propuesta, para el panel. */
export interface RoutePlanProposalSummary {
  candidates: number;
  sheets: number;
  unassigned: number;
  method: string;
  matrixSource: string;
}

/**
 * Planificación del día
 * El cierre, la corrida de la propuesta y la política de pedidos tardíos son del
 * día y no de una hoja: una fila por distribuidora y fecha. Las hojas la
 * referencian por esa clave natural.
 * Casos: CU-107 (M4, hoja de ruta)
 */
@Check(
  'CHK_route_plan_propuesta',
  `"status" IN ('open', 'closed') OR "proposed_at" IS NOT NULL`,
)
@Check(
  'CHK_route_plan_cierre',
  `("status" = 'closed') = ("closed_at" IS NOT NULL)`,
)
@Unique('UQ_route_plan_dia', ['distributorId', 'planDate'])
@Entity('route_plan')
export class RoutePlan {
  @PrimaryGeneratedColumn('uuid', { name: 'plan_id' })
  planId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  /** Día de reparto (hora argentina), `YYYY-MM-DD`. */
  @Column({ name: 'plan_date', type: 'date' })
  planDate!: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: RoutePlanStatus,
    nullable: false,
    default: RoutePlanStatus.OPEN,
  })
  status!: RoutePlanStatus;

  /** Instante del cierre, calculado del parámetro al crear la fila. */
  @Column({ name: 'cutoff_at', type: 'timestamptz' })
  cutoffAt!: Date;

  @Column({ name: 'proposed_at', type: 'timestamptz', nullable: true })
  proposedAt!: Date | null;

  @Column({ name: 'proposal_summary', type: 'jsonb', nullable: true })
  proposalSummary!: RoutePlanProposalSummary | null;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'closed_by_user_id' })
  closedByUser?: User | null;

  @Column({ name: 'closed_by_user_id', type: 'uuid', nullable: true })
  closedByUserId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
