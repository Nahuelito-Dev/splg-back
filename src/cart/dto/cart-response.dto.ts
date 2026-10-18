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

  @ApiProperty({ example: 1100, description: 'Precio vigente del catálogo' })
  currentUnitPrice!: number;

  @ApiProperty({
    example: 100,
    description:
      'Vigente menos guardado: positivo si subió, negativo si bajó, 0 si no cambió',
  })
  priceDifference!: number;

  @ApiProperty({
    example: 2200,
    description:
      'Cantidad por precio vigente. 0 si el tipo ya no está disponible',
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
    description: 'Suma de los subtotales sobre los precios vigentes',
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
