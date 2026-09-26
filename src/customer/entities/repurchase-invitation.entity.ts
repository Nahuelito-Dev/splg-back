import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';
import { UserAddress } from '../../user-address/entities/user-address.entity';
import { Order } from '../../order/entities/order.entity';
import { ProposalStatus } from '../../common/enums/proposal-status.enum';

/**
 * Invitación de recompra
 * Una oferta de reposición al cliente, con el pedido sugerido y una vigencia.
 * Casos: CU-143 a CU-146 y CU-106 (M2)
 */
@Entity('repurchase_invitation')
export class RepurchaseInvitation {
  @PrimaryGeneratedColumn('uuid', { name: 'invitation_id' })
  invitationId!: string;

  @Index()
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor!: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Index()
  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => UserAddress, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'address_id' })
  address?: UserAddress;

  @Column({ name: 'address_id', type: 'uuid', nullable: true })
  addressId!: string | null;

  @Column({
    name: 'projected_depletion_at',
    type: 'timestamptz',
    nullable: false,
  })
  projectedDepletionAt!: Date;

  @Column({ name: 'suggested_items', type: 'jsonb', nullable: false })
  suggestedItems!: Array<{ gasCylinderId: string; quantity: number }>;

  @Column({
    name: 'status',
    type: 'enum',
    enum: ProposalStatus,

    nullable: false,
    default: ProposalStatus.PENDING,
  })
  status!: ProposalStatus;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: false })
  expiresAt!: Date;

  @Column({ name: 'responded_at', type: 'timestamptz', nullable: true })
  respondedAt!: Date | null;

  @ManyToOne(() => Order, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'order_id' })
  order?: Order;

  @Column({ name: 'order_id', type: 'uuid', nullable: true })
  orderId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
