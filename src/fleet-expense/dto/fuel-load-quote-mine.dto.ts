import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsPositive, Max } from 'class-validator';

/** Tope del importe de una carga (lo que entra en `numeric(12,2)`). */
export const IMPORTE_MAXIMO_DE_CARGA = 9_999_999_999.99;

/** Litros y precio por litro de los que el back calcula el importe de la carga del chofer. */
export class CotizarCargaPropiaDto {
  @ApiProperty({ example: 42.5, description: 'Litros cargados' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(IMPORTE_MAXIMO_DE_CARGA)
  liters!: number;

  @ApiProperty({ example: 1050.5, description: 'Precio por litro' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  @Max(IMPORTE_MAXIMO_DE_CARGA)
  unitPrice!: number;
}

export class CotizacionDeCargaPropiaDto {
  @ApiProperty({ example: 42.5 }) liters!: number;
  @ApiProperty({ example: 1050.5 }) unitPrice!: number;
  @ApiProperty({
    example: 44646.25,
    description:
      'Litros × precio por litro, a 2 decimales: el importe con el que se registra la carga',
  })
  totalAmount!: number;
}
