import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body de `PATCH /orders/:id/cancel`. El actor (id + rol) sale SIEMPRE del
 * token autenticado (ver `OrderController.cancel`); acá solo viaja el motivo,
 * opcional, que se guarda a fines informativos/auditoría.
 */
export class CancelOrderDto {
  @ApiProperty({
    description: 'Motivo de la cancelación (opcional)',
    required: false,
    example: 'El cliente no se encontraba en el domicilio',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
