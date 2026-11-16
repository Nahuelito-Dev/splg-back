import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
  Unique,
  Check,
  ForeignKey,
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
@Check(
  'CHK_rating_valores',
  `"stars" BETWEEN 1 AND 5 AND "from_user_id" <> "to_user_id" AND (NOT "hidden" OR "hidden_at" IS NOT NULL)`,
)
@ForeignKey(
  () => Order,
  ['order_id', 'distributor_id'],
  ['order_id', 'distributor_id'],
  { name: 'FK_rating_order_distribuidora', onDelete: 'NO ACTION' },
)
@Check(
  'CHK_rating_largo_de_textos',
  `("comment" IS NULL OR char_length("comment") <= 500) AND ("hidden_reason" IS NULL OR char_length("hidden_reason") <= 500)`,
)
@Entity('rating')
@Unique('UQ_rating_order_role', ['orderId', 'fromRole'])
export class Rating {
  @PrimaryGeneratedColumn('uuid', { name: 'rating_id' })
  ratingId!: string;

  @ManyToOne(() => Order, { onDelete: 'RESTRICT' })
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

  /**
   * Moderación: una calificación oculta no cuenta en promedios ni resúmenes ni
   * se muestra a clientes; el admin la ve marcada. Nunca se borra.
   */
  @Index()
  @Column({ type: 'boolean', default: false })
  hidden!: boolean;

  @Column({ name: 'hidden_reason', type: 'text', nullable: true })
  hiddenReason!: string | null;

  @Column({ name: 'hidden_at', type: 'timestamptz', nullable: true })
  hiddenAt!: Date | null;

  @Column({ name: 'hidden_by_user_id', type: 'uuid', nullable: true })
  hiddenByUserId!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'hidden_by_user_id' })
  hiddenByUser?: User;
}
