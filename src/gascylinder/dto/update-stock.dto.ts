import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

/**
 * Ajuste de stock de un producto.
 *
 * Antes el endpoint recibía el cuerpo con un tipo literal: un valor no
 * numérico viajaba hasta Postgres y reventaba con
 * `invalid input syntax for type integer: "NaN"`.
 */
export class UpdateStockDto {
  @ApiProperty({
    description: 'Unidades a sumar (positivo) o restar (negativo) del stock',
    example: 10,
  })
  @IsInt({ message: 'quantity debe ser un número entero' })
  @Min(-100_000, { message: 'quantity fuera de rango' })
  @Max(100_000, { message: 'quantity fuera de rango' })
  quantity!: number;
}
