import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { RefundKind, RefundStatus } from '../domain/payment.enums';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { Payment } from './payment.entity';
import { Order } from '../../order/entities/order.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';

/**
 * Solicitud de devolución de un pago a la pasarela (CU-168). Hay a lo sumo una
 * por pago y tipo (`UQ_payment_refund_payment_kind`): repetir la operación
 * reutiliza la fila, y su `refund_id` es la clave de idempotencia que viaja a la
 * pasarela, así reintentar no devuelve el dinero dos veces. El monto se fija al
 * crearla.
 */
@Entity('payment_refund')
@Unique('UQ_payment_refund_payment_kind', ['paymentId', 'kind'])
export class PaymentRefund {
  @PrimaryGeneratedColumn('uuid', { name: 'refund_id' })
  refundId!: string;

  @Index()
  @Column({ name: 'payment_id', type: 'uuid' })
  paymentId!: string;

  /** Registro contable: borrar el pago no puede llevarse sus devoluciones. */
  @ManyToOne(() => Payment, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'payment_id' })
  payment?: Payment;

  @Index()
  @Column({ name: 'order_id', type: 'uuid' })
  orderId!: string;

  @ManyToOne(() => Order, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id' })
  order?: Order;

  @Index()
  @Column({ name: 'distributor_id', type: 'uuid', nullable: true })
  distributorId!: string | null;

  @ManyToOne(() => Distributor, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({
    type: 'enum',
    enum: RefundKind,
    enumName: 'payment_refund_kind_enum',
  })
  kind!: RefundKind;

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  amount!: number;

  @Index()
  @Column({
    type: 'enum',
    enum: RefundStatus,
    enumName: 'payment_refund_status_enum',
    default: RefundStatus.PENDING,
  })
  status!: RefundStatus;

  /** Id de la devolución en la pasarela (null si no la hubo o ya estaba devuelto). */
  @Column({
    name: 'gateway_refund_id',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  gatewayRefundId!: string | null;

  /** Por qué falló el último intento. */
  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  /** Cuándo la pasarela confirmó la devolución. */
  @Column({ name: 'refunded_at', type: 'timestamptz', nullable: true })
  refundedAt!: Date | null;

  /** Quién pidió el último reintento manual (null: lo hizo el sistema). */
  @Column({ name: 'requested_by_user_id', type: 'uuid', nullable: true })
  requestedByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
