import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Distributor } from '../../../distributor/entities/distributor.entity';
import { PlatformPlan, type LimitesDelPlan } from './platform-plan.entity';

/**
 * Estado comercial de la suscripción. En P1 todas nacen `active`; la máquina
 * de estados (prueba, mora, restricción) llega en P5.
 */
export enum SubscriptionStatus {
  TRIAL = 'trial',
  ACTIVE = 'active',
  PAST_DUE = 'past_due',
  RESTRICTED = 'restricted',
  SUSPENDED = 'suspended',
  CANCELLED = 'cancelled',
}

/** La foto del plan al asignarlo: el acceso lee esto, no el catálogo de planes. */
export interface FotoDelPlan {
  modules: string[];
  limits: LimitesDelPlan;
  monthlyPrice: string;
  currency: string;
  version: number;
}

/**
 * La foto tiene que traer `modules` (lista) y `limits` (objeto). `?&` exige las
 * claves y el `COALESCE` cierra el NULL de una clave ausente.
 */
export const CHECK_FOTO_DEL_PLAN = `COALESCE(jsonb_typeof("plan_snapshot") = 'object' AND "plan_snapshot" ?& ARRAY['modules', 'limits'] AND jsonb_typeof("plan_snapshot" -> 'modules') = 'array' AND jsonb_typeof("plan_snapshot" -> 'limits') = 'object', false)`;

/**
 * La suscripción de una distribuidora (1:1, DISENO-PLATAFORMA-ORIXTECH §4.3),
 * mínima de P1: plan, foto del plan, estado e `is_internal` (la empresa propia
 * de la plataforma: nunca se factura). Un trigger de la base la crea con el
 * plan `full` al dar de alta una distribuidora.
 */
@Check('CHK_distributor_subscription_foto', CHECK_FOTO_DEL_PLAN)
@Entity('distributor_subscription')
export class DistributorSubscription {
  @PrimaryColumn({
    name: 'distributor_id',
    type: 'uuid',
    primaryKeyConstraintName: 'PK_distributor_subscription',
  })
  distributorId!: string;

  @OneToOne(() => Distributor, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'distributor_id',
    foreignKeyConstraintName: 'FK_distributor_subscription_distributor',
  })
  distributor?: Distributor;

  @Column({ name: 'plan_code', type: 'varchar', length: 30 })
  planCode!: string;

  @ManyToOne(() => PlatformPlan, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'plan_code',
    foreignKeyConstraintName: 'FK_distributor_subscription_plan',
  })
  plan?: PlatformPlan;

  @Column({ name: 'plan_snapshot', type: 'jsonb' })
  planSnapshot!: FotoDelPlan;

  @Column({
    name: 'status',
    type: 'enum',
    enum: SubscriptionStatus,
    enumName: 'subscription_status',
    default: SubscriptionStatus.ACTIVE,
  })
  status!: SubscriptionStatus;

  @Column({ name: 'is_internal', type: 'boolean', default: false })
  isInternal!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
