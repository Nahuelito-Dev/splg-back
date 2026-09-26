import { ApiProperty } from '@nestjs/swagger';
import { IsLatLong } from 'class-validator';

/**
 * Última posición conocida del cliente.
 *
 * Antes el endpoint recibía el cuerpo con un tipo literal y aceptaba
 * cualquier cosa: mandarle el campo mal escrito (`lat_lang` en vez de
 * `latLng`) devolvía 200 sin actualizar nada.
 */
export class UpdateCustomerLocationDto {
  @ApiProperty({
    description: 'Coordenadas del cliente, como "latitud,longitud"',
    example: '-27.3671,-55.8961',
  })
  @IsLatLong({
    message:
      'latLng debe ser "latitud,longitud", por ejemplo -27.3671,-55.8961',
  })
  latLng!: string;
}
