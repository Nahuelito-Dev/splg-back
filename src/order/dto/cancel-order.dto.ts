import { IsOptional, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';

/**
 * Body de `PATCH /orders/:id/cancel`. El actor (id + rol) sale SIEMPRE del
 * token autenticado (ver `OrderController.cancel`); acá solo viaja el motivo.
 * El cliente y el administrador tienen que indicarlo; el chofer, que con este
 * endpoint libera el pedido (no lo cancela), no.
 */
export class CancelOrderDto {
  @ApiProperty({
    description:
      'Motivo de la cancelación. Obligatorio para el cliente y el administrador (400 si falta o está en blanco); el chofer, que libera el pedido, no lo necesita',
    required: false,
    maxLength: 500,
    example: 'El cliente no se encontraba en el domicilio',
  })
  @IsOptional()
  @TextoNoVacio()
  @MaxLength(500)
  reason?: string;
}
