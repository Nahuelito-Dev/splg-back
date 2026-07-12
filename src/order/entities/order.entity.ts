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
import { UserAddress } from '../../user-addres/entities/user-addres.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';

export enum OrderStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  ON_THE_WAY = 'on_the_way',
  DELIVERED = 'delivered',
  CANCELLED = 'cancelled',
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
export class Order {
  @PrimaryGeneratedColumn('uuid', { name: 'order_id' })
  order_id: string;

  /** Tenant dueño del pedido. Nullable hasta backfill del seed. */
  @Index()
  @ManyToOne(() => Distributor, { nullable: true })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ type: 'uuid', nullable: true })
  distributor_id?: string;

  @ManyToOne(() => User, (user) => user.customer, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customer_id' })
  customer: User;

  @Column({ type: 'uuid' })
  customer_id: string;

  @ManyToOne(() => Delivery, { nullable: true })
  @JoinColumn({ name: 'delivery_id' })
  delivery: Delivery;

  @ManyToOne(() => TimeSlot, { nullable: true })
  @JoinColumn({ name: 'time_slot_id' })
  timeSlot: TimeSlot;

  @Column({ nullable: true })
  time_slot_id: string;

  /**
   * Fecha agendada de entrega (YYYY-MM-DD). Null = pedido inmediato ("lo antes
   * posible", comportamiento previo). Con fecha + time_slot_id, el pedido está
   * agendado a esa franja de ese día (valida capacidad al crear).
   */
  @Index()
  @Column({ type: 'date', nullable: true })
  scheduled_date?: string | null;

  @Column({ nullable: true })
  delivery_id: string | null;

  @ManyToOne(() => UserAddress)
  @JoinColumn({ name: 'address_id' })
  address: UserAddress;

  @Column({ type: 'uuid' })
  address_id: string;

  @Column({
    type: 'enum',
    enum: OrderStatus,
    default: OrderStatus.PENDING,
  })
  status: OrderStatus;

  @Column({
    type: 'enum',
    enum: PaymentMethod,
  })
  paymentMethod: PaymentMethod;

  @Column({
    type: 'enum',
    enum: PaymentType,
    default: PaymentType.CASH,
  })
  paymentType: PaymentType;

  @Column({
    type: 'enum',
    enum: PaymentStatus,
    default: PaymentStatus.PENDING,
  })
  paymentStatus: PaymentStatus;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  totalAmount: number;

  @Column({ type: 'text', nullable: true })
  notes: string;

  @Column({ type: 'text', nullable: true })
  deliveryInstructions: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  deliveryLatitude: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  deliveryLongitude: string;

  @Column({ type: 'timestamp', nullable: true })
  acceptedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  onTheWayAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  deliveredAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => OrderItem, (item) => item.order, { cascade: true })
  items: OrderItem[];

  @Column({ type: 'text', nullable: true })
  cancellationReason: string | null;

  /**
   * ID del pago en la pasarela (MercadoPago) que marcó este pedido como PAID.
   * Índice único PARCIAL (solo cuando no es null): garantiza idempotencia del
   * webhook — un mismo `payment.id` no puede confirmar dos pedidos, y permite
   * detectar reintentos (si ya está seteado, no se re-despacha).
   */
  @Index({ unique: true, where: '"gatewayPaymentId" IS NOT NULL' })
  @Column({ type: 'varchar', length: 100, nullable: true })
  gatewayPaymentId: string | null;

  /**
   * Código secreto de la prueba de entrega con QR. Se genera al ACEPTAR el
   * pedido (ver UpdateOrderStatusUseCase) y viaja embebido en el QR que el
   * chofer muestra en su app. El cliente lo obtiene ÚNICAMENTE escaneando ese
   * QR físico; si al confirmar la entrega el código matchea, es prueba de que
   * el chofer estuvo presente (ConfirmDeliveryUseCase).
   */
  @Column({ type: 'varchar', length: 12, nullable: true })
  deliveryCode: string | null;
}
