import { Expose, Type } from 'class-transformer';

/** El producto de un renglón. Sale como `gas_cylinder_id`, `type`, etc. */
export class ProductoDelRenglonDto {
  @Expose({ name: 'gas_cylinder_id' })
  id!: string;

  type!: string;
  weight!: number;
  price!: number;
  description!: string | null;
}

/** Un renglón del pedido. El producto sale como `gas_cylinder`. */
export class OrderItemResponseDto {
  @Expose({ name: 'quantity' })
  quantity!: number;

  @Expose({ name: 'gas_cylinder' })
  @Type(() => ProductoDelRenglonDto)
  cylinder!: ProductoDelRenglonDto | null;
}

export class AddressResponseDto {
  @Expose({ name: 'address_id' })
  id!: string;

  street!: string;
  city!: string;

  @Expose({ name: 'postal_code' })
  postalCode!: string | null;

  latitude!: string | null;
  longitude!: string | null;

  @Expose({ name: 'formatted_address' })
  formattedAddress!: string | null;

  @Expose({ name: 'additional_instructions' })
  additionalInstructions!: string | null;
}

export class OrderResponseDto {
  @Expose({ name: 'order_id' })
  id!: string;

  @Expose({ name: 'total_amount' })
  total!: number;

  status!: string; // mapped value

  @Expose({ name: 'created_at' })
  createdAt!: Date;

  @Expose({ name: 'payment_method' })
  paymentMethod!: string; // mapped value (online/cash)

  @Expose({ name: 'delivery_address' })
  @Type(() => AddressResponseDto)
  address!: AddressResponseDto | null;

  @Expose({ name: 'delivery_id' })
  deliveryId!: string | null;

  @Expose({ name: 'delivery_name' })
  deliveryName!: string | null;

  @Expose({ name: 'delivery_notes' })
  deliveryNotes!: string | null;

  @Expose({ name: 'customer_notes' })
  customerNotes!: string | null;

  @Expose({ name: 'delivery_window_start' })
  deliveryWindowStart!: string | null;

  @Expose({ name: 'delivery_window_end' })
  deliveryWindowEnd!: string | null;

  @Expose({ name: 'actual_delivery_date' })
  actualDeliveryDate!: Date | null;

  @Expose({ name: 'requested_delivery_date' })
  requestedDeliveryDate!: Date | null;

  @Expose({ name: 'order_items' })
  @Type(() => OrderItemResponseDto)
  items!: OrderItemResponseDto[];

  /**
   * URL de Checkout Pro (MercadoPago) a la que redirigir al cliente para
   * pagar. Solo presente cuando el pedido se creó con paymentMethod
   * MERCADOPAGO y la preferencia se pudo generar.
   */
  @Expose({ name: 'payment_url' })
  paymentUrl?: string;

  /** Fecha agendada de entrega (YYYY-MM-DD) o null si es inmediata. */
  scheduledDate?: string | null;

  /** Seña de la reserva (0 si no es reserva). */
  depositAmount?: number;

  /** Si la seña ya fue pagada. */
  depositPaid?: boolean;

  /** Saldo a cobrar al entregar (total - seña paga). */
  remainingBalance?: number;
}
