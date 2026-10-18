import { Expose, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CoverageZoneSurchargeType } from '../../coverage-zone/entities/coverage-zone.entity';
import {
  OrderDeliveryMode,
  PaymentMethod,
  PaymentStatus,
} from '../entities/order.entity';

/*
 * El contrato de pedidos que consumen las apps y el panel. Los nombres de la
 * respuesta salen de `@Expose` (snake_case); `@ApiProperty({ name })` repite
 * ese nombre para que Swagger describa lo que viaja de verdad.
 */

/** El producto de un renglón. Sale como `gas_cylinder_id`, `type`, etc. */
export class ProductoDelRenglonDto {
  @ApiProperty({ name: 'gas_cylinder_id', format: 'uuid' })
  @Expose({ name: 'gas_cylinder_id' })
  id!: string;

  @ApiProperty({ example: '10kg' })
  type!: string;
  @ApiProperty({ example: 10 })
  weight!: number;
  @ApiProperty({ example: 11300 })
  price!: number;
  @ApiProperty({ type: String, nullable: true })
  description!: string | null;
}

/** Un renglón del pedido. El producto sale como `gas_cylinder`. */
export class OrderItemResponseDto {
  @ApiProperty({ example: 2 })
  @Expose({ name: 'quantity' })
  quantity!: number;

  @ApiProperty({
    name: 'unit_price',
    example: 14900,
    description:
      'Precio unitario con el que se vendió el renglón (snapshot, no el del catálogo).',
  })
  @Expose({ name: 'unit_price' })
  unitPrice!: number;

  @ApiProperty({
    example: 29800,
    description: 'Subtotal del renglón tal como quedó guardado.',
  })
  @Expose({ name: 'subtotal' })
  subtotal!: number;

  @ApiProperty({
    name: 'gas_cylinder',
    type: ProductoDelRenglonDto,
    nullable: true,
  })
  @Expose({ name: 'gas_cylinder' })
  @Type(() => ProductoDelRenglonDto)
  cylinder!: ProductoDelRenglonDto | null;
}

export class AddressResponseDto {
  @ApiProperty({ name: 'address_id', format: 'uuid' })
  @Expose({ name: 'address_id' })
  id!: string;

  @ApiProperty() street!: string;
  @ApiProperty() city!: string;

  @ApiProperty({ name: 'postal_code', type: String, nullable: true })
  @Expose({ name: 'postal_code' })
  postalCode!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '-27.3671' })
  latitude!: string | null;
  @ApiProperty({ type: String, nullable: true, example: '-55.8961' })
  longitude!: string | null;

  @ApiProperty({ name: 'formatted_address', type: String, nullable: true })
  @Expose({ name: 'formatted_address' })
  formattedAddress!: string | null;

  @ApiProperty({
    name: 'additional_instructions',
    type: String,
    nullable: true,
  })
  @Expose({ name: 'additional_instructions' })
  additionalInstructions!: string | null;
}

/**
 * Datos del cliente que hizo el pedido. Clave nueva (`customer`), pensada para
 * el panel: las apps no la usan pero tampoco la rompen, y viaja `null` si el
 * pedido no trae la relación cargada.
 */
export class CustomerDeOrderDto {
  @ApiProperty({ name: 'user_id', format: 'uuid' })
  @Expose({ name: 'user_id' })
  userId!: string;

  @ApiProperty({ name: 'full_name', type: String, nullable: true })
  @Expose({ name: 'full_name' })
  fullName!: string | null;

  @ApiProperty({ name: 'phone_number', type: String, nullable: true })
  @Expose({ name: 'phone_number' })
  phoneNumber!: string | null;

  @ApiProperty({ type: String, nullable: true })
  email!: string | null;
}

/**
 * Recargo por zona de cobertura, tal como quedó registrado en el pedido
 * (snapshot): no cambia aunque la zona se edite o se borre después.
 */
export class ZoneSurchargeDto {
  @ApiProperty({ name: 'coverage_zone_id', format: 'uuid' })
  @Expose({ name: 'coverage_zone_id' })
  coverageZoneId!: string;

  @ApiProperty({ example: 'Villa Lanús' })
  name!: string;

  @ApiProperty({ enum: CoverageZoneSurchargeType })
  type!: CoverageZoneSurchargeType;

  @ApiProperty({
    example: 10,
    description:
      'Valor crudo de la zona (monto si es fixed, % si es percentage).',
  })
  value!: number;

  @ApiProperty({
    example: 2000,
    description: 'Recargo ya calculado, en la moneda del pedido.',
  })
  amount!: number;
}

/**
 * Vehículo con el que se entrega, tal como quedó registrado en el pedido
 * (snapshot al aceptarlo): no cambia aunque el chofer cambie de vehículo o
 * el auto se edite/borre después.
 */
export class VehicleDeOrderDto {
  @ApiProperty({ name: 'car_id', format: 'uuid' })
  @Expose({ name: 'car_id' })
  carId!: string;

  @ApiProperty({ type: String, nullable: true, example: 'AB123CD' })
  patent!: string | null;

  @ApiProperty({ type: String, nullable: true }) brand!: string | null;
  @ApiProperty({ type: String, nullable: true }) model!: string | null;
}

/**
 * El chofer del pedido, visto por el cliente dueño y por el admin mientras el
 * pedido está activo (aceptado o en camino). Es lo que la app del cliente
 * muestra al reabrir; en vivo llega por socket (`order:accepted`).
 */
export class DriverLocationDto {
  @ApiProperty({ example: -34.6037 }) lat!: number;
  @ApiProperty({ example: -58.3816 }) lng!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-10-12T20:15:00.000Z',
    description:
      'Cuándo se registró (ISO); `null` si la posición es anterior a que el back anotara la hora',
  })
  at!: string | null;
}

export class DriverDeOrderDto {
  @ApiProperty({ format: 'uuid', description: '`user_id` del chofer' })
  userId!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Ana Gómez' })
  fullName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '+5491155550000' })
  phoneNumber!: string | null;

  @ApiProperty({
    example: 4.8,
    description:
      'Promedio de estrellas de las calificaciones visibles (0 si todavía no tiene)',
  })
  ratingAverage!: number;

  @ApiProperty({
    example: 37,
    description: 'Cantidad de calificaciones visibles',
  })
  ratingCount!: number;

  @ApiProperty({
    type: DriverLocationDto,
    nullable: true,
    description:
      'Última ubicación conocida del chofer (la misma que se emite por `order:driver-location`); `null` si todavía no reportó ninguna',
  })
  location!: DriverLocationDto | null;
}

/**
 * Quién recibe el pedido (CU-128). Datos de un tercero: sólo los ven el cliente
 * dueño, el chofer asignado y el administrador de la distribuidora, y se
 * anulan al vencer el plazo de reclamo.
 */
export class ReceiverDeOrderDto {
  @ApiProperty({ type: String, nullable: true, example: 'María Gómez' })
  name!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '30123456' })
  document!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'vecina' })
  relationship!: string | null;
}

export class OrderResponseDto {
  @ApiProperty({ name: 'order_id', format: 'uuid' })
  @Expose({ name: 'order_id' })
  id!: string;

  /** Distribuidora dueña del pedido: el super admin la necesita para operar sin «Ver como». */
  @ApiProperty({ name: 'distributor_id', format: 'uuid' })
  @Expose({ name: 'distributor_id' })
  distributorId!: string;

  @ApiProperty({ name: 'total_amount', example: 22600 })
  @Expose({ name: 'total_amount' })
  total!: number;

  @ApiProperty({
    description:
      'Estado para las apps: `on_the_way` sale como `out_for_delivery`',
    enum: [
      'reserved',
      'pending',
      'accepted',
      'out_for_delivery',
      'delivered',
      'cancelled',
    ],
  })
  status!: string; // mapped value

  @ApiProperty({ name: 'created_at', type: String, format: 'date-time' })
  @Expose({ name: 'created_at' })
  createdAt!: Date;

  @ApiProperty({
    name: 'payment_method',
    enum: ['cash', 'online', 'account'],
    description:
      'Tipo de pago: efectivo, online (MercadoPago, transferencia) o cuenta corriente (`account`: no se cobra en la entrega)',
  })
  @Expose({ name: 'payment_method' })
  paymentMethod!: string; // mapped value (online/cash)

  @ApiProperty({
    enum: PaymentMethod,
    example: 'transfer',
    description:
      'Medio de pago real del pedido (`payment_method` agrupa como online todo lo que no es efectivo)',
  })
  paymentMethodDetail!: PaymentMethod;

  @ApiProperty({
    enum: PaymentStatus,
    example: 'pending',
    description:
      'Estado del pago: pendiente, cobrado, fallido, impago (el chofer informó que el cliente no pagó el efectivo) o perdido (`written_off`, impago dado por perdido por un admin). Un pedido en efectivo entregado queda `pending` hasta que el chofer confirma el cobro.',
  })
  paymentStatus!: PaymentStatus;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Cuándo se COBRÓ el efectivo: lo confirmó el chofer o el admin resolvió el impago como `paid`. Queda `null` si el impago se dio por perdido (`written_off`): una pérdida no es un cobro, ver `paymentResolvedAt`.',
  })
  paymentConfirmedAt!: Date | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Usuario que confirmó el cobro (chofer o admin). `null` si el impago se dio por perdido.',
  })
  paymentConfirmedBy!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Cuándo un admin resolvió el impago (`paid` o `written_off`), o registró el cobro manual (`register-cash`, `confirm-transfer`). Con `paymentStatus: unpaid` es cuándo el admin lo registró (`register-unpaid`); `resolve-unpaid` lo reemplaza. `null` si nadie lo tocó.',
  })
  paymentResolvedAt!: Date | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Admin que resolvió el impago (`paid` o `written_off`) o registró el cobro manual. Con `paymentStatus: unpaid`, el admin que lo registró.',
  })
  paymentResolvedBy!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Motivo del admin: la resolución del impago, el cobro manual o, con `paymentStatus: unpaid`, el motivo con que registró el impago.',
  })
  paymentResolutionNote!: string | null;

  @ApiProperty({
    example: true,
    description:
      'Regla del pedido, no del rol: está pendiente, sin chofer y sin pago online en curso o cobrado. No dice si quien lo consulta puede editarlo: `PATCH /orders/:id` es de administradores (un cliente o un chofer recibe 403 aunque sea `true`).',
  })
  editable!: boolean;

  @ApiProperty({
    enum: OrderDeliveryMode,
    example: OrderDeliveryMode.STANDARD,
    description:
      'Modalidad de entrega vigente. Un pedido express que ninguna moto aceptó pasa a `standard` (ver `expressDegradedAt`).',
  })
  deliveryMode!: OrderDeliveryMode;

  @ApiProperty({
    example: 0,
    description:
      'Recargo express que se cobró al pedir (0 si nunca fue express). Se conserva aunque el pedido pase al reparto común: en ese caso el `total_amount` ya no lo incluye.',
  })
  expressSurchargeAmount!: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Cuándo ninguna moto aceptó y el pedido pasó al reparto común sin el recargo (null si no pasó)',
  })
  expressDegradedAt!: Date | null;

  @ApiProperty({
    name: 'delivery_address',
    type: AddressResponseDto,
    nullable: true,
  })
  @Expose({ name: 'delivery_address' })
  @Type(() => AddressResponseDto)
  address!: AddressResponseDto | null;

  @ApiProperty({
    name: 'delivery_id',
    type: String,
    format: 'uuid',
    nullable: true,
  })
  @Expose({ name: 'delivery_id' })
  deliveryId!: string | null;

  @ApiProperty({ name: 'delivery_name', type: String, nullable: true })
  @Expose({ name: 'delivery_name' })
  deliveryName!: string | null;

  @ApiProperty({ name: 'delivery_notes', type: String, nullable: true })
  @Expose({ name: 'delivery_notes' })
  deliveryNotes!: string | null;

  @ApiProperty({ name: 'customer_notes', type: String, nullable: true })
  @Expose({ name: 'customer_notes' })
  customerNotes!: string | null;

  @ApiProperty({ name: 'delivery_window_start', type: String, nullable: true })
  @Expose({ name: 'delivery_window_start' })
  deliveryWindowStart!: string | null;

  @ApiProperty({ name: 'delivery_window_end', type: String, nullable: true })
  @Expose({ name: 'delivery_window_end' })
  deliveryWindowEnd!: string | null;

  @ApiProperty({
    name: 'actual_delivery_date',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  @Expose({ name: 'actual_delivery_date' })
  actualDeliveryDate!: Date | null;

  @ApiProperty({
    name: 'requested_delivery_date',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  @Expose({ name: 'requested_delivery_date' })
  requestedDeliveryDate!: Date | null;

  @ApiProperty({
    name: 'order_items',
    type: OrderItemResponseDto,
    isArray: true,
  })
  @Expose({ name: 'order_items' })
  @Type(() => OrderItemResponseDto)
  items!: OrderItemResponseDto[];

  /**
   * URL de Checkout Pro (MercadoPago) a la que redirigir al cliente para
   * pagar. Solo presente cuando el pedido se creó con paymentMethod
   * MERCADOPAGO y la preferencia se pudo generar.
   */
  @ApiPropertyOptional({ name: 'payment_url' })
  @Expose({ name: 'payment_url' })
  paymentUrl?: string;

  /** Fecha agendada de entrega (YYYY-MM-DD) o null si es inmediata. */
  @ApiPropertyOptional({ type: String, format: 'date', nullable: true })
  scheduledDate?: string | null;

  /** Seña de la reserva (0 si no es reserva). */
  @ApiPropertyOptional({ example: 0 })
  depositAmount?: number;

  /** Si la seña ya fue pagada. */
  @ApiPropertyOptional()
  depositPaid?: boolean;

  /** Saldo a cobrar al entregar (total - seña paga). */
  @ApiPropertyOptional({ example: 22600 })
  remainingBalance?: number;

  /**
   * Datos del cliente que compró (para el panel). `null` si el pedido no trae
   * la relación cargada; nunca se omite la clave.
   */
  @ApiProperty({ name: 'customer', type: CustomerDeOrderDto, nullable: true })
  @Expose({ name: 'customer' })
  @Type(() => CustomerDeOrderDto)
  customer!: CustomerDeOrderDto | null;

  /**
   * Quién va a recibir el pedido (CU-128). `null` si el cliente no lo indicó, si
   * ya venció el plazo de reclamo, o si quien consulta es un chofer al que el
   * pedido todavía no le está asignado.
   */
  @ApiProperty({ type: ReceiverDeOrderDto, nullable: true })
  @Type(() => ReceiverDeOrderDto)
  receiver!: ReceiverDeOrderDto | null;

  /** Motivo de cancelación, si el pedido se canceló. */
  @ApiProperty({ name: 'cancellation_reason', type: String, nullable: true })
  @Expose({ name: 'cancellation_reason' })
  cancellationReason!: string | null;

  /** Cuándo un chofer aceptó el pedido. */
  @ApiProperty({
    name: 'accepted_at',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  @Expose({ name: 'accepted_at' })
  acceptedAt!: Date | null;

  /** Cuándo el pedido pasó a "en camino". */
  @ApiProperty({
    name: 'on_the_way_at',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  @Expose({ name: 'on_the_way_at' })
  onTheWayAt!: Date | null;

  /**
   * Recargo por zona de cobertura al momento de pedir, o `null` si la
   * distribuidora no tenía zonas definidas (no-op) o el pedido es de antes de
   * esta funcionalidad.
   */
  @ApiProperty({
    name: 'zone_surcharge',
    type: ZoneSurchargeDto,
    nullable: true,
  })
  @Expose({ name: 'zone_surcharge' })
  @Type(() => ZoneSurchargeDto)
  zoneSurcharge!: ZoneSurchargeDto | null;

  /** Subtotal de los ítems (ya con promociones), antes de cualquier recargo. */
  @ApiProperty({ name: 'subtotal_items', example: 20000 })
  @Expose({ name: 'subtotal_items' })
  subtotalItems!: number;

  /**
   * Vehículo con el que se entrega (snapshot al aceptar). `null` si todavía
   * no tiene chofer asignado, o es de antes de esta funcionalidad.
   */
  @ApiProperty({ name: 'vehicle', type: VehicleDeOrderDto, nullable: true })
  @Expose({ name: 'vehicle' })
  @Type(() => VehicleDeOrderDto)
  vehicle!: VehicleDeOrderDto | null;

  /**
   * Quién canceló el pedido: `customer`, `admin` (admin o super admin),
   * `driver` o `system` (lo canceló el sistema, p. ej. al vencer el pago).
   * `null` si el pedido no está cancelado o es de antes de que se registrara
   * el historial de estados. El evento `order:cancelled` lleva el mismo campo,
   * pero sólo cuando cancela una persona: los vencimientos automáticos no
   * emiten el evento, así que `system` se ve únicamente al leer el pedido.
   */
  @ApiProperty({
    name: 'cancelledBy',
    enum: ['customer', 'admin', 'system', 'driver'],
    nullable: true,
  })
  @Expose({ name: 'cancelledBy' })
  cancelledBy!: 'customer' | 'admin' | 'system' | 'driver' | null;

  /**
   * Chofer asignado: nombre, teléfono y calificación. Sólo en
   * `GET /orders/{id}`, sólo para el cliente dueño y el admin, y sólo mientras
   * el pedido esté `accepted` o `out_for_delivery`; con el pedido cerrado, sin
   * chofer, o visto por el chofer, es `null` (no se expone el teléfono). La
   * patente del vehículo está en `vehicle.patent`.
   */
  @ApiProperty({ name: 'driver', type: DriverDeOrderDto, nullable: true })
  @Expose({ name: 'driver' })
  @Type(() => DriverDeOrderDto)
  driver!: DriverDeOrderDto | null;
}
