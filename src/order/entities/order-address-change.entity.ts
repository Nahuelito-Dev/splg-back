import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { Order } from './order.entity';
import { UserAddress } from '../../user-address/entities/user-address.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Cambio de dirección
 * Historial de cambios de dirección de entrega sobre un pedido.
 * Casos: CU-127 y CU-128
 */
@Entity('order_address_change')
export class OrderAddressChange {
  @PrimaryGeneratedColumn('uuid', { name: 'change_id' })
  changeId!: string;

  @ManyToOne(() => Order, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId!: string;

  @ManyToOne(() => UserAddress, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'from_address_id' })
  fromAddress!: UserAddress;

  @Column({ name: 'from_address_id', type: 'uuid' })
  fromAddressId!: string;

  @ManyToOne(() => UserAddress, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'to_address_id' })
  toAddress!: UserAddress;

  @Column({ name: 'to_address_id', type: 'uuid' })
  toAddressId!: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'changed_by_user_id' })
  changedByUser!: User;

  @Column({ name: 'changed_by_user_id', type: 'uuid' })
  changedByUserId!: string;

  @CreateDateColumn({ name: 'changed_at', type: 'timestamptz' })
  changedAt!: Date;

  @Column({ name: 'reason', type: 'text', nullable: true })
  reason!: string | null;
}
