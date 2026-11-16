import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsUUID, Max, Min } from 'class-validator';
import { CANTIDAD_MAXIMA_POR_ITEM } from '../domain/cart-view';

export class AddCartItemDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Tipo de garrafa del catálogo de la distribuidora',
  })
  @IsUUID()
  gasCylinderId!: string;

  @ApiProperty({
    example: 2,
    minimum: 1,
    maximum: CANTIDAD_MAXIMA_POR_ITEM,
    description:
      'Entero positivo. Si el tipo ya está en el carrito, se suma a lo que tenía',
  })
  @IsInt()
  @Min(1)
  @Max(CANTIDAD_MAXIMA_POR_ITEM)
  quantity!: number;
}
