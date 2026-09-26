import { Expose, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

export class OrderResponseDto {
  @ApiProperty({ name: 'order_id', format: 'uuid' })
  @Expose({ name: 'order_id' })
  id!: string;

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
}
