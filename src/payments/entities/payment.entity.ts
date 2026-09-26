import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import {
  PaymentGateway,
  PaymentIntegration,
  LedgerPaymentStatus,
} from '../domain/payment.enums';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { Order } from '../../order/entities/order.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';

/**
 * Ledger de pagos: UN registro por INTENTO de cobro (append-friendly). No
 * reemplaza `order.paymentStatus`/`order.gatewayPaymentId` (que reflejan el
 * estado del PEDIDO, decidido por `ConfirmPaymentUseCase` en el módulo
 * `order`) — este es el registro histórico, multi-gateway, del lado de pagos:
 * cuánto se intentó cobrar, con qué pasarela/integración, y en qué quedó.
 *
 * Un pedido puede tener más de un `Payment` (ej. reintento tras un checkout
 * caído), pero como máximo uno queda con `gateway_payment_id` set por cada
 * pago real aprobado en la pasarela (índice único parcial).
 */
@Entity('payment')
export class Payment {
  @PrimaryGeneratedColumn('uuid', { name: 'payment_id' })
  payment_id!: string;

  /** Pedido al que pertenece este intento de cobro. */
  @Index()
  @Column({ type: 'uuid' })
  order_id!: string;

  /** Registro contable: borrar el pedido no puede llevarse sus pagos. */
  @ManyToOne(() => Order, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id' })
  order?: Order;

  /** Tenant dueño del pago (igual que el pedido). Nullable hasta backfill. */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  distributor_id!: string | null;

  @ManyToOne(() => Distributor, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ type: 'enum', enum: PaymentGateway })
  gateway!: PaymentGateway;

  @Column({ type: 'enum', enum: PaymentIntegration })
  integration!: PaymentIntegration;

  /** Medio de pago concreto dentro de la pasarela (ej. 'credit_card', 'account_money'). */
  @Column({ type: 'varchar', length: 50, nullable: true })
  method!: string | null;

  /**
   * ID del pago en la pasarela. Null mientras el intento está PENDING (recién
   * se conoce cuando el webhook confirma el pago real). Índice único PARCIAL
   * (solo cuando no es null): un mismo pago de la pasarela no puede confirmar
   * dos registros del ledger — garantiza la idempotencia del webhook del lado
   * del ledger, igual que el índice análogo en `order.gatewayPaymentId`.
   */
  @Index({ unique: true, where: '"gateway_payment_id" IS NOT NULL' })
  @Column({ type: 'varchar', length: 100, nullable: true })
  gateway_payment_id!: string | null;

  /** Referencia externa enviada a la pasarela (= order_id). */
  @Column({ type: 'varchar', nullable: true })
  external_reference!: string | null;

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  amount!: number;

  @Column({ type: 'varchar', length: 10, default: 'ARS' })
  currency!: string;

  @Column({
    type: 'enum',
    enum: LedgerPaymentStatus,
    default: LedgerPaymentStatus.PENDING,
  })
  status!: LedgerPaymentStatus;

  /** URL de checkout devuelta por la pasarela (Checkout Pro init_point). */
  @Column({ type: 'text', nullable: true })
  payment_url!: string | null;

  /** true = este intento cobra la SEÑA de una reserva, no el pedido completo. */
  @Column({ type: 'boolean', default: false })
  is_deposit!: boolean;

  /** Datos crudos/auxiliares de la pasarela (preferenceId, status crudo, etc.). */
  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
