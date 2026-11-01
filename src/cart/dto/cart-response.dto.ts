import { ApiProperty } from '@nestjs/swagger';

export class CartItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  cartItemId!: string;

  @ApiProperty({ format: 'uuid' })
  gasCylinderId!: string;

  @ApiProperty({ example: '10kg' })
  type!: string;

  @ApiProperty({ example: 2 })
  quantity!: number;

  @ApiProperty({
    example: 1000,
    description: 'Precio que vio el cliente al agregar el ítem',
  })
  savedUnitPrice!: number;

  @ApiProperty({
    example: 1050,
    description:
      'Precio unitario vigente CON la promoción por volumen aplicada: el mismo que cotiza y cobra el pedido (igual a promoUnitPrice)',
  })
  currentUnitPrice!: number;

  @ApiProperty({
    example: 1100,
    description: 'Precio de lista vigente del catálogo, sin promoción',
  })
  listUnitPrice!: number;

  @ApiProperty({
    example: 5,
    description:
      '% de descuento por volumen que alcanza la cantidad del renglón; 0 si no hay promoción aplicable',
  })
  discountPercentage!: number;

  @ApiProperty({
    example: 1045,
    description:
      'Precio unitario con la promoción aplicada y redondeado a 2 decimales (igual al de lista si no hay promoción)',
  })
  promoUnitPrice!: number;

  @ApiProperty({
    example: 100,
    description:
      'Precio de lista vigente menos el guardado: positivo si subió, negativo si bajó, 0 si no cambió (las promociones no cuentan como cambio)',
  })
  priceDifference!: number;

  @ApiProperty({
    example: 2200,
    description:
      'Cantidad por precio unitario con promoción. 0 si el tipo ya no está disponible',
  })
  subtotal!: number;

  @ApiProperty({
    description:
      'false si el tipo de garrafa se dio de baja después de agregarlo: se muestra pero no suma al total',
  })
  available!: boolean;

  @ApiProperty({
    description:
      'false si el stock vendible no alcanza para la cantidad. El carrito no reserva stock: se controla al crear el pedido',
  })
  hasEnoughStock!: boolean;
}

export class CartResponseDto {
  @ApiProperty({
    format: 'uuid',
    type: String,
    nullable: true,
    description: 'null si el cliente todavía no tiene carrito (se ve vacío)',
  })
  cartId!: string | null;

  @ApiProperty({ format: 'uuid' })
  distributorId!: string;

  @ApiProperty({ type: () => CartItemResponseDto, isArray: true })
  items!: CartItemResponseDto[];

  @ApiProperty({ description: 'Unidades de los ítems disponibles' })
  totalUnits!: number;

  @ApiProperty({
    example: 2200,
    description:
      'Suma de los subtotales con promoción. NO incluye recargo de zona, de pago online ni express: el total a pagar lo da POST /orders/quote',
  })
  total!: number;

  @ApiProperty({
    description: 'Algún ítem tiene un precio distinto al guardado',
  })
  hasPriceChanges!: boolean;

  @ApiProperty({ description: 'Algún ítem ya no está disponible' })
  hasUnavailableItems!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  updatedAt!: Date | null;
}
