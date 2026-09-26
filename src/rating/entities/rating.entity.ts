import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
  Unique,
} from 'typeorm';
import { Order } from '../../order/entities/order.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';

/** Quién emite la calificación (define a quién califica: el otro lado del pedido). */
export enum RaterRole {
  CUSTOMER = 'customer',
  DELIVERY = 'delivery',
}

/**
 * Calificación bidireccional de un pedido entregado: el cliente califica al
 * chofer y el chofer al cliente. Una calificación por pedido y por lado
 * (unique order_id + from_role): no se puede calificar dos veces el mismo
 * pedido desde el mismo rol. Tenant-scoped (distributor_id denormalizado del
 * pedido) para que los promedios/queries del panel sean por distribuidora.
 */
@Entity('rating')
@Unique('UQ_rating_order_role', ['orderId', 'fromRole'])
export class Rating {
  @PrimaryGeneratedColumn('uuid', { name: 'rating_id' })
  ratingId!: string;

  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Index()
  @Column({
    name: 'order_id',
    type: 'uuid',
  })
  orderId!: string;

  @Index()
  @ManyToOne(() => Distributor, { nullable: false })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({
    name: 'distributor_id',
    type: 'uuid',
    nullable: false,
  })
  distributorId!: string;

  /** Usuario que emite la calificación (user_id). */
  @Column({
    name: 'from_user_id',
    type: 'uuid',
  })
  fromUserId!: string;

  /** Relación al usuario que califica (para mostrar su nombre en el panel). */
  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'from_user_id' })
  fromUser?: User;

  /** Usuario calificado (el otro lado del pedido) (user_id). */
  @Index()
  @Column({
    name: 'to_user_id',
    type: 'uuid',
  })
  toUserId!: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'to_user_id' })
  toUser?: User;

  @Column({
    name: 'from_role',
    type: 'enum',
    enum: RaterRole,
  })
  fromRole!: RaterRole;

  /** 1 a 5 estrellas. */
  @Column({ type: 'int' })
  stars!: number;

  @Column({ type: 'text', nullable: true })
  comment!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
