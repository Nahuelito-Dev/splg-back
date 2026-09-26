import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Punto a chequear contra las zonas de una distribuidora. */
export class CheckCoverageDto {
  @ApiProperty({
    description: 'Latitud del punto a consultar',
    example: -27.3671,
  })
  @Type(() => Number)
  @IsLatitude({ message: 'lat debe ser una latitud válida' })
  lat!: number;

  @ApiProperty({
    description: 'Longitud del punto a consultar',
    example: -55.8961,
  })
  @Type(() => Number)
  @IsLongitude({ message: 'lng debe ser una longitud válida' })
  lng!: number;

  @ApiPropertyOptional({
    example: 22000,
    description:
      'Subtotal de los ítems (ya con promociones). Si se manda, la respuesta ' +
      'incluye `amount`: el recargo de zona ya calculado sobre ese subtotal.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  subtotal?: number;
}
