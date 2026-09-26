import { IsLatitude, IsLongitude } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body de `PATCH /orders/:id/location`. El chofer reporta su posición actual
 * mientras hace la entrega. `lat`/`lng` viajan como string (igual que las
 * columnas `deliveryLatitude`/`deliveryLongitude` de `Order`, que son
 * `decimal` hidratados como string) — no se cambia el tipo, solo se valida
 * que representen coordenadas reales dentro de rango.
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
