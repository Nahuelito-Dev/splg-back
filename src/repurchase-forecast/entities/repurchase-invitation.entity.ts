import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
  Check,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';
import { UserAddress } from '../../user-address/entities/user-address.entity';
import { Order, PaymentMethod } from '../../order/entities/order.entity';
import { TimeSlot } from '../../time-slot/entities/time-slot.entity';
import { RepurchaseEstimateSource } from '../domain/estimacion-de-recompra';

export { RepurchaseEstimateSource };

/** Cómo va una invitación de recompra (CU-106). */
export enum RepurchaseInvitationStatus {
  /** Abierta: el cliente todavía puede aceptarla. */
  PENDING = 'pending',
  /** El cliente la aceptó y el pedido se creó. */
  ACCEPTED = 'accepted',
  /** El cliente la descartó. */
  REJECTED = 'rejected',
  /** Pasó la vigencia sin respuesta. */
  EXPIRED = 'expired',
  /** Se cerró sin efecto: el cliente compró por su cuenta mientras corría. */
  CANCELLED = 'cancelled',
}

export interface SuggestedItem {
  gasCylinderId: string;
  quantity: number;
}

/**
 * Invitación de recompra
 * Una oferta de reposición al cliente, con el pedido sugerido y una vigencia.
 * Una sola abierta por cliente y distribuidora (`UQ_repurchase_invitation_abierta`).
 * Casos: CU-106 (M3), con la fecha de CU-146 y el aviso de CU-145.
 */
@Check('CHK_repurchase_invitation_vigencia', `"expires_at" > "created_at"`)
@Check(
  'CHK_repurchase_invitation_respuesta',
  `("status" = 'pending') = ("responded_at" IS NULL)`,
)
@Check(
  'CHK_repurchase_invitation_pedido',
  `("status" = 'accepted') = ("order_id" IS NOT NULL)`,
)
@Check(
  'CHK_repurchase_invitation_renglones',
  `jsonb_typeof("suggested_items") = 'array' AND jsonb_array_length("suggested_items") > 0`,
)
@Check(
  'CHK_repurchase_invitation_parametros',
  `("estimate_kg_per_day" IS NULL OR "estimate_kg_per_day" > 0) AND ("estimate_orders_used" IS NULL OR "estimate_orders_used" >= 0)`,
)
@Check(
  'CHK_repurchase_invitation_fuente',
  `"estimate_source" IN ('history', 'declared')`,
)
@Check(
  'CHK_repurchase_invitation_pago',
  `"payment_method" IN ('cash', 'transfer', 'mercadopago')`,
)
@Index('UQ_repurchase_invitation_abierta', ['distributorId', 'userId'], {
  unique: true,
  where: `"status" = 'pending'`,
})
@Index('IDX_repurchase_invitation_estado', [
  'distributorId',
  'status',
  'createdAt',
])
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

  /** La franja horaria habitual del cliente, si todavía existe y está activa. */
  @ManyToOne(() => TimeSlot, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'time_slot_id',
    foreignKeyConstraintName: 'FK_repurchase_invitation_time_slot',
  })
  timeSlot?: TimeSlot;

  @Column({ name: 'time_slot_id', type: 'uuid', nullable: true })
  timeSlotId!: string | null;

  /** Cómo paga habitualmente (efectivo, transferencia o MercadoPago). */
  @Column({
    name: 'payment_method',
    type: 'varchar',
    length: 20,
    default: PaymentMethod.CASH,
  })
  paymentMethod!: PaymentMethod;

  @Column({
    name: 'projected_depletion_at',
    type: 'timestamptz',
    nullable: false,
  })
  projectedDepletionAt!: Date;

  /** Kilos por día con los que se proyectó (promedio de sus compras ajustado por temporada); nulo en las invitaciones anteriores a la medición. */
  @Column({ name: 'estimate_kg_per_day', type: 'float', nullable: true })
  estimateKgPerDay!: number | null;

  /** Compras del cliente que entraron en la estimación; nulo en las invitaciones anteriores a la medición. */
  @Column({ name: 'estimate_orders_used', type: 'integer', nullable: true })
  estimateOrdersUsed!: number | null;

  /** Con qué se estimó: sus compras o el consumo que declaró. */
  @Column({
    name: 'estimate_source',
    type: 'varchar',
    length: 10,
    default: RepurchaseEstimateSource.HISTORY,
  })
  estimateSource!: RepurchaseEstimateSource;

  @Column({ name: 'suggested_items', type: 'jsonb', nullable: false })
  suggestedItems!: SuggestedItem[];

  @Column({
    name: 'status',
    type: 'enum',
    enum: RepurchaseInvitationStatus,
    nullable: false,
    default: RepurchaseInvitationStatus.PENDING,
  })
  status!: RepurchaseInvitationStatus;

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
