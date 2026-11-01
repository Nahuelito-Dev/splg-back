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
  Check,
  ForeignKey,
  Unique,
} from 'typeorm';
import type { Point } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { OrderItem } from './order-item.entity';
import { TimeSlot } from '../../time-slot/entities/time-slot.entity';
import { UserAddress } from '../../user-address/entities/user-address.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import {
  CoverageZone,
  CoverageZoneSurchargeType,
} from '../../coverage-zone/entities/coverage-zone.entity';
import { Car } from '../../car/entities/car.entity';

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
  /** Venta a cuenta corriente: sólo la carga el administrador desde el panel. */
  ACCOUNT = 'account',
}

export enum PaymentType {
  CASH = 'cash',
  ONLINE = 'online',
  ACCOUNT = 'account',
}

export enum PaymentStatus {
  PENDING = 'pending',
  PAID = 'paid',
  FAILED = 'failed',
  /** Efectivo entregado y el chofer informó que el cliente no pagó. */
  UNPAID = 'unpaid',
  /** Impago que el administrador dio por perdido. */
  WRITTEN_OFF = 'written_off',
}

@Check(
  'CHK_order_liberacion_por_fraude',
  `"payment_fraud_released_at" IS NULL OR ("payment_fraud_released_by" IS NOT NULL AND char_length(btrim("payment_fraud_released_reason")) >= 10)`,
)
@Check(
  'CHK_order_montos',
  `"totalAmount" >= 0 AND "subtotal_items" >= 0 AND "zone_surcharge_amount" >= 0 AND "express_surcharge_amount" >= 0 AND "payment_surcharge_amount" >= 0 AND "deposit_amount" >= 0`,
)
@Check(
  'CHK_order_recargo_porcentaje',
  `"payment_surcharge_percentage" IS NULL OR ("payment_surcharge_percentage" BETWEEN 0 AND 30 AND ("payment_surcharge_amount" = 0 OR "payment_surcharge_percentage" > 0))`,
)
@Check(
  'CHK_order_total_formula',
  `"totalAmount" = "subtotal_items" + "zone_surcharge_amount" + "payment_surcharge_amount" + CASE WHEN "express_degraded_at" IS NULL THEN "express_surcharge_amount" ELSE 0 END`,
)
@Check(
  'CHK_order_pago_coherente',
  `("paymentMethod" = 'cash') = ("paymentType" = 'cash') AND ("paymentMethod" = 'account') = ("paymentType" = 'account')`,
)
@Check(
  'CHK_order_aceptado_fecha',
  `"status" NOT IN ('accepted', 'on_the_way', 'delivered') OR "acceptedAt" IS NOT NULL`,
)
@Check(
  'CHK_order_en_camino_fecha',
  `"status" NOT IN ('on_the_way', 'delivered') OR "onTheWayAt" IS NOT NULL`,
)
@Check(
  'CHK_order_entregado_fecha',
  `("status" = 'delivered') = ("deliveredAt" IS NOT NULL)`,
)
@Check(
  'CHK_order_chofer_asignado',
  `"status" NOT IN ('accepted', 'on_the_way', 'delivered') OR "delivery_id" IS NOT NULL`,
)
@Check(
  'CHK_order_cancelado_motivo',
  `"status" <> 'cancelled' OR btrim(coalesce("cancellationReason", '')) <> ''`,
)
@ForeignKey(
  () => Delivery,
  ['delivery_id', 'distributor_id'],
  ['delivery_id', 'distributor_id'],
  { name: 'FK_order_delivery_distribuidora', onDelete: 'NO ACTION' },
)
@ForeignKey(
  () => CoverageZone,
  ['coverage_zone_id', 'distributor_id'],
  ['coverage_zone_id', 'distributor_id'],
  { name: 'FK_order_coverage_zone_distribuidora', onDelete: 'NO ACTION' },
)
@ForeignKey(
  () => TimeSlot,
  ['time_slot_id', 'distributor_id'],
  ['time_slot_id', 'distributor_id'],
  { name: 'FK_order_time_slot_distribuidora', onDelete: 'NO ACTION' },
)
@ForeignKey(
  () => Car,
  ['vehicle_car_id', 'distributor_id'],
  ['car_id', 'distributor_id'],
  { name: 'FK_order_vehicle_car_distribuidora', onDelete: 'NO ACTION' },
)
@Unique('UQ_order_id_distribuidora', ['orderId', 'distributorId'])
@Check(
  'CHK_order_nota_de_impago_largo',
  `"payment_resolution_note" IS NULL OR (char_length("payment_resolution_note") <= 500 AND char_length(btrim("payment_resolution_note")) >= 10)`,
)
@Entity('order')
// Índices compuestos para las queries calientes:
//  - dispatch: PENDING AND delivery_id IS NULL (query central, corre por pedido + cron)
@Index('idx_order_status_delivery', ['status', 'deliveryId'])
//  - reports/stats scopeados por tenant y rango de fecha
@Index('idx_order_dist_status_delivered', [
  'distributorId',
  'status',
  'deliveredAt',
])
export class Order {
  @PrimaryGeneratedColumn('uuid', { name: 'order_id' })
  orderId!: string;

  /** Tenant dueño del pedido. */
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
  @Column({
    name: 'customer_id',
    type: 'uuid',
  })
  customerId!: string;

  @ManyToOne(() => Delivery, { nullable: true })
  @JoinColumn({ name: 'delivery_id' })
  delivery!: Delivery | null;

  @ManyToOne(() => TimeSlot, { nullable: true })
  @JoinColumn({ name: 'time_slot_id' })
  timeSlot!: TimeSlot | null;

  @Column({
    name: 'time_slot_id',
    type: 'uuid',
    nullable: true,
  })
  timeSlotId!: string | null;

  /**
   * Fecha agendada de entrega (YYYY-MM-DD). Null = pedido inmediato ("lo antes
   * posible", comportamiento previo). Con fecha + time_slot_id, el pedido está
   * agendado a esa franja de ese día (valida capacidad al crear).
   */
  @Index()
  @Column({
    name: 'scheduled_date',
    type: 'date',
    nullable: true,
  })
  scheduledDate?: string | null;

  /** Seña de la pre-reserva (0 = pedido normal, no reserva). */
  @Column({
    name: 'deposit_amount',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
    default: 0,
  })
  depositAmount!: number;

  /** Si la seña ya fue pagada (habilita la activación automática de la reserva). */
  @Column({
    name: 'deposit_paid',
    type: 'boolean',
    default: false,
  })
  depositPaid!: boolean;

  /**
   * Mercado Pago avisó una alerta de fraude (`stop_delivery_op_wh`) sobre el pago de
   * este pedido y pidió no entregarlo: no se ofrece, no se acepta, no se asigna y una
   * reserva no se activa. Es una retención aparte del estado del pago (que sigue
   * `paid`/seña paga); se resuelve cancelando el pedido.
   */
  @Column({ name: 'payment_fraud_hold', type: 'boolean', default: false })
  paymentFraudHold!: boolean;

  /** Cuándo un administrador liberó la retención por fraude (queda el motivo y quién). */
  @Column({
    name: 'payment_fraud_released_at',
    type: 'timestamptz',
    nullable: true,
  })
  paymentFraudReleasedAt!: Date | null;

  @Column({ name: 'payment_fraud_released_by', type: 'uuid', nullable: true })
  paymentFraudReleasedBy!: string | null;

  /** Motivo con el que el administrador liberó la retención. */
  @Column({
    name: 'payment_fraud_released_reason',
    type: 'text',
    nullable: true,
  })
  paymentFraudReleasedReason!: string | null;

  /** Cuándo el administrador confirmó la seña recibida en efectivo o por transferencia. */
  @Column({ name: 'deposit_paid_at', type: 'timestamptz', nullable: true })
  depositPaidAt!: Date | null;

  @Column({
    name: 'delivery_id',
    type: 'uuid',
    nullable: true,
  })
  deliveryId!: string | null;

  @ManyToOne(() => UserAddress)
  @JoinColumn({ name: 'address_id' })
  address!: UserAddress;

  @Column({
    name: 'address_id',
    type: 'uuid',
  })
  addressId!: string;

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

  /** Cuándo se confirmó el cobro (pago recibido por el chofer o resolución del admin). */
  @Column({ name: 'payment_confirmed_at', type: 'timestamptz', nullable: true })
  paymentConfirmedAt!: Date | null;

  /** Usuario que confirmó el cobro (el chofer, o el admin que resolvió el impago). */
  @ForeignKey('user', {
    name: 'FK_order_payment_confirmed_by',
    onDelete: 'RESTRICT',
  })
  @Column({ name: 'payment_confirmed_by', type: 'uuid', nullable: true })
  paymentConfirmedBy!: string | null;

  /** Motivo con el que el admin resolvió un impago. */
  /** Cuándo un admin resolvió el impago (cobrado después o pérdida). */
  @Column({ name: 'payment_resolved_at', type: 'timestamptz', nullable: true })
  paymentResolvedAt!: Date | null;

  /** Admin que resolvió el impago. */
  @ForeignKey('user', {
    name: 'FK_order_payment_resolved_by',
    onDelete: 'RESTRICT',
  })
  @Column({ name: 'payment_resolved_by', type: 'uuid', nullable: true })
  paymentResolvedBy!: string | null;

  @Column({ name: 'payment_resolution_note', type: 'text', nullable: true })
  paymentResolutionNote!: string | null;

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

  /**
   * Dónde se entrega: el punto de la dirección al momento de pedir. Es una
   * copia a propósito, porque la dirección del cliente puede cambiar después
   * (el cambio de dirección de un pedido queda en `order_address_change`). El
   * despacho busca los choferes más cercanos a este punto. La posición del
   * chofer no se guarda acá: vive en Redis (H-91).
   */
  @Column({
    type: 'geometry',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  deliveryPoint!: Point | null;

  @Column({ type: 'timestamptz', nullable: true })
  acceptedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  onTheWayAt!: Date | null;

  @Index()
  @Column({ type: 'timestamptz', nullable: true })
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
   * Motivo de la transición de estado que se está guardando. No es una columna:
   * lo lee `OrderStatusHistorySubscriber` al asentar la fila del historial y
   * lo limpia. Si no se pone y el pedido pasa a `cancelled`, usa
   * `cancellationReason`.
   */
  transitionReason?: string | null;

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
  receiverName!: string | null;

  @Column({
    name: 'receiver_document',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  receiverDocument!: string | null;

  @Column({
    name: 'receiver_relationship',
    type: 'varchar',
    length: 40,
    nullable: true,
  })
  receiverRelationship!: string | null;

  @Column({
    name: 'delivery_mode',
    type: 'enum',
    enum: OrderDeliveryMode,

    nullable: false,
    default: OrderDeliveryMode.STANDARD,
  })
  deliveryMode!: OrderDeliveryMode;

  /**
   * Recargo express que se cobró al pedir (CU-147). Queda guardado aunque el
   * pedido pase al reparto común (`express_degraded_at`), para poder explicar el
   * total y saber cuánto reintegrar; el `total_amount` ya no lo incluye en ese caso.
   */
  @Column({
    name: 'express_surcharge_amount',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
    default: 0,
  })
  expressSurchargeAmount!: number;

  /** Cuándo ningún chofer en moto aceptó y el pedido pasó al reparto común (CU-149). */
  @Column({ name: 'express_degraded_at', type: 'timestamptz', nullable: true })
  expressDegradedAt!: Date | null;

  /**
   * Snapshot de la zona de cobertura al momento de pedir (delivery/coverage-
   * zone.service). `coverage_zone_id` es sólo trazabilidad: si la zona se
   * edita o se borra después, este pedido NO cambia — el total ya cobrado se
   * reconstruye con `zone_name` + `zone_surcharge_*` + `subtotal_items`, no
   * releyendo la zona.
   */
  @ManyToOne(() => CoverageZone, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'coverage_zone_id' })
  coverageZone!: CoverageZone | null;

  @Column({ name: 'coverage_zone_id', type: 'uuid', nullable: true })
  coverageZoneId!: string | null;

  @Column({ name: 'zone_name', type: 'varchar', length: 120, nullable: true })
  zoneName!: string | null;

  @Column({
    name: 'zone_surcharge_type',
    type: 'enum',
    enum: CoverageZoneSurchargeType,
    nullable: true,
  })
  zoneSurchargeType!: CoverageZoneSurchargeType | null;

  /** Valor crudo de la zona al momento de pedir (monto o %, según el tipo). */
  @Column({
    name: 'zone_surcharge_value',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
    nullable: true,
  })
  zoneSurchargeValue!: number | null;

  /** Recargo YA calculado (monto en la moneda del pedido). 0 si no hay zona. */
  @Column({
    name: 'zone_surcharge_amount',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
    default: 0,
  })
  zoneSurchargeAmount!: number;

  /**
   * Recargo por medio de pago online (+10 % de MercadoPago o transferencia),
   * calculado sobre el subtotal de los ítems más el recargo de zona. 0 si se
   * paga en efectivo o a cuenta. Con el resto de los recargos explica el total
   * (`CHK_order_total_formula`).
   */
  @Column({
    name: 'payment_surcharge_amount',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
    default: 0,
  })
  paymentSurchargeAmount!: number;

  /**
   * Porcentaje de recargo por medio de pago con que se calculó
   * `payment_surcharge_amount` (parámetro de la distribuidora al momento de
   * crear o recalcular el pedido). Un cambio posterior del parámetro no altera
   * el pedido. `null` en los pedidos anteriores a que fuera configurable (regía
   * 10 % online y 0 % en efectivo).
   */
  @Column({
    name: 'payment_surcharge_percentage',
    type: 'decimal',
    precision: 5,
    scale: 2,
    nullable: true,
    transformer: columnNumericTransformer,
  })
  paymentSurchargePercentage!: number | null;

  /** Subtotal de los ítems (ya con promociones), antes de cualquier recargo. */
  @Column({
    name: 'subtotal_items',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  subtotalItems!: number;

  /**
   * Snapshot del vehículo con el que se entrega, tomado al aceptar el
   * pedido (manual, `PATCH /orders/:id/status` o despacho automático): el
   * vehículo EN USO del chofer en ese momento (decisión de nahue del 30/09,
   * "vehículo en uso"). Igual que `zone_name`/`zone_surcharge_*`, es una
   * copia a propósito: si el chofer cambia de vehículo después, o el auto
   * se edita o se borra, este pedido no cambia — queda la trazabilidad de
   * con qué vehículo se entregó de verdad. `null` en pedidos sin chofer
   * asignado todavía, o de antes de esta funcionalidad.
   */
  @ForeignKey('car', {
    name: 'FK_order_vehicle_car',
    onDelete: 'SET NULL',
  })
  @Column({ name: 'vehicle_car_id', type: 'uuid', nullable: true })
  vehicleCarId!: string | null;

  @Column({
    name: 'vehicle_patent',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  vehiclePatent!: string | null;

  @Column({
    name: 'vehicle_brand',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  vehicleBrand!: string | null;

  @Column({
    name: 'vehicle_model',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  vehicleModel!: string | null;
}
