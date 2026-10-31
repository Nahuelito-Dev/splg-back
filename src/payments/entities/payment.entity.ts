import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
  Check,
} from 'typeorm';
import {
  PaymentGateway,
  PaymentIntegration,
  LedgerPaymentStatus,
} from '../domain/payment.enums';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { Order } from '../../order/entities/order.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { MercadoPagoCredentials } from '../../distributor/entities/mercadopago-credentials.entity';

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
@Check('CHK_payment_importe', `"amount" > 0`)
@Entity('payment')
export class Payment {
  @PrimaryGeneratedColumn('uuid', { name: 'payment_id' })
  paymentId!: string;

  /** Pedido al que pertenece este intento de cobro. */
  @Index()
  @Column({
    name: 'order_id',
    type: 'uuid',
  })
  orderId!: string;

  /** Registro contable: borrar el pedido no puede llevarse sus pagos. */
  @ManyToOne(() => Order, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id' })
  order?: Order;

  /** Tenant dueño del pago (igual que el pedido). Nullable hasta backfill. */
  @Index()
  @Column({
    name: 'distributor_id',
    type: 'uuid',
    nullable: true,
  })
  distributorId!: string | null;

  @ManyToOne(() => Distributor, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  /**
   * Cuenta de Mercado Pago con la que se cobró: la credencial propia de la
   * distribuidora o `null` para la del sistema. El webhook, la consulta y la
   * devolución del pago usan siempre esa cuenta, aunque después se la desactive.
   */
  @Column({ name: 'credential_id', type: 'uuid', nullable: true })
  credentialId!: string | null;

  @ManyToOne(() => MercadoPagoCredentials, {
    nullable: true,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'credential_id' })
  credential?: MercadoPagoCredentials;

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
  @Column({
    name: 'gateway_payment_id',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  gatewayPaymentId!: string | null;

  /** Referencia externa enviada a la pasarela (= order_id). */
  @Column({
    name: 'external_reference',
    type: 'varchar',
    nullable: true,
  })
  externalReference!: string | null;

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
  @Column({
    name: 'payment_url',
    type: 'text',
    nullable: true,
  })
  paymentUrl!: string | null;

  /** Cuándo la pasarela lo aprobó (null mientras no se aprobó). Desde esta fecha cuenta como cobro. */
  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt!: Date | null;

  /** true = este intento cobra la SEÑA de una reserva, no el pedido completo. */
  @Column({
    name: 'is_deposit',
    type: 'boolean',
    default: false,
  })
  isDeposit!: boolean;

  /** Datos crudos/auxiliares de la pasarela (preferenceId, status crudo, etc.). */
  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
