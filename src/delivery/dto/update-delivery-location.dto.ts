import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsLatLong, IsOptional, IsString, MaxLength } from 'class-validator';

/** Posición reportada por la app del chofer mientras hace un reparto. */
export class UpdateDeliveryLocationDto {
  @ApiProperty({
    description: 'Coordenadas del chofer, como "latitud,longitud"',
    example: '-27.3671,-55.8961',
  })
  @IsLatLong({
    message:
      'latLng debe ser "latitud,longitud", por ejemplo -27.3671,-55.8961',
  })
  latLng!: string;

  @ApiPropertyOptional({
    description: 'Dirección aproximada, para mostrarla en el panel',
    example: 'Av. Mitre 1234, Posadas',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  actualLocation?: string;
}
