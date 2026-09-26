import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { Order, OrderStatus } from './order.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Cambio de estado del pedido
 * Una fila por transición de estado de un pedido.
 * Casos: CU-018 a CU-020, CU-008 a CU-010 (decidido el 23/09)
 */
@Entity('order_status_history')
export class OrderStatusHistory {
  @PrimaryGeneratedColumn('uuid', { name: 'history_id' })
  historyId!: string;

  @ManyToOne(() => Order, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId!: string;

  @Column({
    name: 'from_status',
    type: 'enum',
    enum: OrderStatus,
    enumName: 'order_status_enum',
    nullable: true,
  })
  fromStatus!: OrderStatus | null;

  @Column({
    name: 'to_status',
    type: 'enum',
    enum: OrderStatus,
    enumName: 'order_status_enum',
    nullable: false,
  })
  toStatus!: OrderStatus;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'changed_by_user_id' })
  changedByUser?: User;

  @Column({ name: 'changed_by_user_id', type: 'uuid', nullable: true })
  changedByUserId!: string | null;

  @Column({ name: 'reason', type: 'text', nullable: true })
  reason!: string | null;

  @CreateDateColumn({ name: 'changed_at', type: 'timestamptz' })
  changedAt!: Date;
}
