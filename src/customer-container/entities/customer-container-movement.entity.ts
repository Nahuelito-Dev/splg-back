import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { CustomerContainerAccount } from './customer-container-account.entity';
import { Order } from '../../order/entities/order.entity';
import { User } from '../../users/entities/user.entity';

export enum CustomerContainerMovementReason {
  INITIAL_FROM_DELIVERIES = 'initial_from_deliveries',
  PURCHASED = 'purchased',
  MANUAL_ADJUSTMENT = 'manual_adjustment',
  RETURNED = 'returned',
}

@Check('CHK_customer_container_movement_quantity', '"quantity" <> 0')
@Check(
  'CHK_customer_container_movement_note',
  `"reason" <> 'manual_adjustment' OR char_length(btrim("note")) BETWEEN 10 AND 500`,
)
@ForeignKey(
  () => CustomerContainerAccount,
  ['account_id', 'distributor_id'],
  ['account_id', 'distributor_id'],
  {
    name: 'FK_customer_container_movement_account_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@ForeignKey(
  () => Order,
  ['order_id', 'distributor_id'],
  ['order_id', 'distributor_id'],
  {
    name: 'FK_customer_container_movement_order_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@ForeignKey(() => User, ['actor_user_id'], ['user_id'], {
  name: 'FK_customer_container_movement_actor',
  onDelete: 'SET NULL',
})
@Entity('customer_container_movement')
@Index('IDX_customer_container_movement_account_created', [
  'accountId',
  'createdAt',
])
@Index('UQ_customer_container_movement_inicial', ['accountId'], {
  unique: true,
  where: `"reason" = 'initial_from_deliveries'`,
})
@Index('UQ_customer_container_movement_compra', ['accountId', 'orderId'], {
  unique: true,
  where: `"reason" = 'purchased'`,
})
export class CustomerContainerMovement {
  @PrimaryGeneratedColumn('uuid', { name: 'movement_id' })
  movementId!: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId!: string;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({ type: 'int' })
  quantity!: number;

  @Column({
    type: 'enum',
    enum: CustomerContainerMovementReason,
    name: 'reason',
  })
  reason!: CustomerContainerMovementReason;

  @Column({ name: 'order_id', type: 'uuid', nullable: true })
  orderId!: string | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
