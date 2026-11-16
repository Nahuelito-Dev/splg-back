import { IsLatitude, IsLongitude } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body de `PATCH /orders/:id/location`. El chofer reporta su posición actual
 * mientras hace la entrega; va al radar (Redis GEO), no al pedido. `lat`/`lng`
 * viajan como string, como siempre, y se valida que estén dentro de rango.
 */
export class UpdateLocationDto {
  @ApiProperty({
    description: 'Latitud actual del repartidor',
    example: '-34.603722',
  })
  @IsLatitude({ message: 'lat debe ser una latitud válida' })
  lat!: string;

  @ApiProperty({
    description: 'Longitud actual del repartidor',
    example: '-58.381592',
  })
  @IsLongitude({ message: 'lng debe ser una longitud válida' })
  lng!: string;
}
