import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { CylinderState } from './cylinder.entity';

/**
 * Auditoría de cada transición de estado de un `Cylinder`. Registra quién
 * la hizo (actor_user_id), en el contexto de qué pedido (order_id, si aplica)
 * y por qué (note). Es append-only: no se edita ni se borra, solo se lee para
 * reconstruir la trazabilidad del envase.
 */
@Entity('cylinder_movement')
export class CylinderMovement {
  @PrimaryGeneratedColumn('uuid', { name: 'movement_id' })
  movement_id: string;

  @Index()
  @Column({ type: 'uuid' })
  cylinder_id: string;

  @Index()
  @Column({ type: 'uuid' })
  distributor_id: string;

  @Column({ type: 'enum', enum: CylinderState, nullable: true })
  from_state: CylinderState | null;

  @Column({ type: 'enum', enum: CylinderState })
  to_state: CylinderState;

  /** Pedido en cuyo contexto ocurrió la transición (dispatch/entrega), si aplica. */
  @Column({ type: 'uuid', nullable: true })
  order_id?: string | null;

  /** Usuario (chofer/admin) que ejecutó la transición, si aplica. */
  @Column({ type: 'uuid', nullable: true })
  actor_user_id?: string | null;

  @Column({ type: 'text', nullable: true })
  note?: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
