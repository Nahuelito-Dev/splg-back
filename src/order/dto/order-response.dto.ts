import { Expose, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CoverageZoneSurchargeType } from '../../coverage-zone/entities/coverage-zone.entity';

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
    enum: ['cash', 'online'],
    description: 'Tipo de pago: efectivo u online (MercadoPago)',
  })
  @Expose({ name: 'payment_method' })
  paymentMethod!: string; // mapped value (online/cash)

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
}
