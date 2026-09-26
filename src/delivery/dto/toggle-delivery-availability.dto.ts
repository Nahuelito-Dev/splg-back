import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Disponibilidad del chofer para recibir ofertas de reparto.
 *
 * Es distinto del estado: un chofer activo puede estar no disponible porque
 * terminó su turno.
 */
export class ToggleDeliveryAvailabilityDto {
  @ApiProperty({
    description: 'true habilita al chofer para recibir ofertas',
    example: true,
  })
  @IsBoolean({ message: 'available tiene que ser true o false' })
  available!: boolean;
}
