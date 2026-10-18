import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { CANTIDAD_MAXIMA_POR_ITEM } from '../domain/cart-view';

export class UpdateCartItemDto {
  @ApiProperty({
    example: 3,
    minimum: 1,
    maximum: CANTIDAD_MAXIMA_POR_ITEM,
    description:
      'Cantidad nueva (reemplaza a la anterior). Para dejarlo en cero hay que quitar el ítem',
  })
  @IsInt()
  @Min(1, {
    message:
      'La cantidad tiene que ser un entero positivo; para dejarlo en cero, quitá el ítem',
  })
  @Max(CANTIDAD_MAXIMA_POR_ITEM)
  quantity!: number;
}
