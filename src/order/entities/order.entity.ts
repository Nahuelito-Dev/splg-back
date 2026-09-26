// order/entities/order.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { OrderItem } from './order-item.entity';
import { TimeSlot } from '../../time-slot/entities/time-slot.entity';
import { UserAddress } from '../../user-address/entities/user-address.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';

export enum OrderStatus {
  /**
   * RESERVED = pre-reserva: el cliente reservó a futuro con una seña. El stock
   * queda reservado pero NO se despacha. El sistema lo activa solo (cron) el día
   * agendado si la seña está paga (RESERVED → PENDING).
   */
  RESERVED = 'reserved',
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  ON_THE_WAY = 'on_the_way',
  DELIVERED = 'delivered',
  CANCELLED = 'cancelled',
}

export enum OrderDeliveryMode {
  STANDARD = 'standard',
  EXPRESS = 'express',
}

export enum PaymentMethod {
  CASH = 'cash',
  MERCADOPAGO = 'mercadopago',
  TRANSFER = 'transfer',
}

export enum PaymentType {
  CASH = 'cash',
  ONLINE = 'online',
}

export enum PaymentStatus {
  PENDING = 'pending',
  PAID = 'paid',
  FAILED = 'failed',
}

@Entity('order')
// Índices compuestos para las queries calientes:
//  - dispatch: PENDING AND delivery_id IS NULL (query central, corre por pedido + cron)
@Index('idx_order_status_delivery', ['status', 'delivery_id'])
//  - reports/stats scopeados por tenant y rango de fecha
@Index('idx_order_dist_status_delivered', [
  'distributor_id',
  'status',
  'deliveredAt',
])
export class Order {
  @PrimaryGeneratedColumn('uuid', { name: 'order_id' })
  order_id!: string;

  /** Tenant dueño del pedido. */
  @Index()
  @ManyToOne(() => Distributor, { nullable: false })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ type: 'uuid', nullable: false })
  distributor_id!: string;

  /**
   * `RESTRICT` (no `CASCADE`): `customer_id` es NOT NULL, así que `SET NULL`
   * no aplica. Con `CASCADE`, borrar un usuario borraba en cascada TODOS sus
   * pedidos — pérdida de historial contable. Con `RESTRICT`, Postgres rechaza
   * el DELETE físico de un usuario que tenga pedidos (P2-10 de
   * `docs/ARQUITECTURA-REVIEW.md`); hay que dar de baja al usuario (soft-delete/
   * bloqueo) en vez de borrarlo.
   */
  @ManyToOne(() => User, (user) => user.customer, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'customer_id' })
  customer!: User;

  @Index()
  @Column({ type: 'uuid' })
  customer_id!: string;

  @ManyToOne(() => Delivery, { nullable: true })
  @JoinColumn({ name: 'delivery_id' })
  delivery!: Delivery | null;

  @ManyToOne(() => TimeSlot, { nullable: true })
  @JoinColumn({ name: 'time_slot_id' })
  timeSlot!: TimeSlot | null;

  @Column({ type: 'uuid', nullable: true })
  time_slot_id!: string | null;

  /**
   * Fecha agendada de entrega (YYYY-MM-DD). Null = pedido inmediato ("lo antes
   * posible", comportamiento previo). Con fecha + time_slot_id, el pedido está
   * agendado a esa franja de ese día (valida capacidad al crear).
   */
  @Index()
  @Column({ type: 'date', nullable: true })
  scheduled_date?: string | null;

  /** Seña de la pre-reserva (0 = pedido normal, no reserva). */
  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
    default: 0,
  })
  deposit_amount!: number;

  /** Si la seña ya fue pagada (habilita la activación automática de la reserva). */
  @Column({ type: 'boolean', default: false })
  deposit_paid!: boolean;

  @Column({ type: 'uuid', nullable: true })
  delivery_id!: string | null;

  @ManyToOne(() => UserAddress)
  @JoinColumn({ name: 'address_id' })
  address!: UserAddress;

  @Column({ type: 'uuid' })
  address_id!: string;

  @Index()
  @Column({
    type: 'enum',
    enum: OrderStatus,
    default: OrderStatus.PENDING,
  })
  status!: OrderStatus;

  @Column({
    type: 'enum',
    enum: PaymentMethod,
  })
  paymentMethod!: PaymentMethod;

  @Column({
    type: 'enum',
    enum: PaymentType,
    default: PaymentType.CASH,
  })
  paymentType!: PaymentType;

  @Column({
    type: 'enum',
    enum: PaymentStatus,
    default: PaymentStatus.PENDING,
  })
  paymentStatus!: PaymentStatus;

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  totalAmount!: number;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'text', nullable: true })
  deliveryInstructions!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  deliveryLatitude!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  deliveryLongitude!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  acceptedAt!: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  onTheWayAt!: Date | null;

  @Index()
  @Column({ type: 'timestamp', nullable: true })
  deliveredAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => OrderItem, (item) => item.order, { cascade: true })
  items!: OrderItem[];

  @Column({ type: 'text', nullable: true })
  cancellationReason!: string | null;

  /**
   * ID del pago en la pasarela (MercadoPago) que marcó este pedido como PAID.
   * Índice único PARCIAL (solo cuando no es null): garantiza idempotencia del
   * webhook — un mismo `payment.id` no puede confirmar dos pedidos, y permite
   * detectar reintentos (si ya está seteado, no se re-despacha).
   */
  @Index({ unique: true, where: '"gatewayPaymentId" IS NOT NULL' })
  @Column({ type: 'varchar', length: 100, nullable: true })
  gatewayPaymentId!: string | null;

  /**
   * Código secreto de la prueba de entrega con QR. Se genera al ACEPTAR el
   * pedido (ver UpdateOrderStatusUseCase) y viaja embebido en el QR que el
   * chofer muestra en su app. El cliente lo obtiene ÚNICAMENTE escaneando ese
   * QR físico; si al confirmar la entrega el código matchea, es prueba de que
   * el chofer estuvo presente (ConfirmDeliveryUseCase).
   */
  @Column({ type: 'varchar', length: 12, nullable: true })
  deliveryCode!: string | null;

  @Column({
    name: 'receiver_name',
    type: 'varchar',
    length: 120,
    nullable: true,
  })
  receiver_name!: string | null;

  @Column({
    name: 'receiver_document',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  receiver_document!: string | null;

  @Column({
    name: 'receiver_relationship',
    type: 'varchar',
    length: 40,
    nullable: true,
  })
  receiver_relationship!: string | null;

  @Column({
    name: 'delivery_mode',
    type: 'enum',
    enum: OrderDeliveryMode,

    nullable: false,
    default: OrderDeliveryMode.STANDARD,
  })
  delivery_mode!: OrderDeliveryMode;
}
