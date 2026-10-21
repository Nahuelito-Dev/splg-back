import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
  Check,
} from 'typeorm';
import { Cylinder, CylinderState } from './cylinder.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { Order } from '../../order/entities/order.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Auditoría de cada transición de estado de un `Cylinder`. Registra quién
 * la hizo (actor_user_id), en el contexto de qué pedido (order_id, si aplica)
 * y por qué (note). Es append-only: no se edita ni se borra, solo se lee para
 * reconstruir la trazabilidad del envase.
 */
@Check(
  'CHK_cylinder_movement_cambio',
  `"from_state" IS NULL OR "from_state"::text <> "to_state"::text OR "note" IS NOT NULL`,
)
@Entity('cylinder_movement')
export class CylinderMovement {
  @PrimaryGeneratedColumn('uuid', { name: 'movement_id' })
  movementId!: string;

  @Index()
  @Column({
    name: 'cylinder_id',
    type: 'uuid',
  })
  cylinderId!: string;

  /** Trazabilidad: el historial no se pierde porque se borre el envase. */
  @ManyToOne(() => Cylinder, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'cylinder_id' })
  cylinder?: Cylinder;

  @Index()
  @Column({
    name: 'distributor_id',
    type: 'uuid',
  })
  distributorId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({
    name: 'from_state',
    type: 'enum',
    enum: CylinderState,
    nullable: true,
  })
  fromState!: CylinderState | null;

  @Column({
    name: 'to_state',
    type: 'enum',
    enum: CylinderState,
  })
  toState!: CylinderState;

  /** Pedido en cuyo contexto ocurrió la transición (dispatch/entrega), si aplica. */
  @Column({
    name: 'order_id',
    type: 'uuid',
    nullable: true,
  })
  orderId!: string | null;

  @ManyToOne(() => Order, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'order_id' })
  order?: Order;

  /** Usuario (chofer/admin) que ejecutó la transición, si aplica. */
  @Column({
    name: 'actor_user_id',
    type: 'uuid',
    nullable: true,
  })
  actorUserId!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'actor_user_id' })
  actor?: User;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
