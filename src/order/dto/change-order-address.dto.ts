import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID, MaxLength } from 'class-validator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';

/** Cuerpo de `PATCH /orders/:id/address` (CU-127). */
export class ChangeOrderAddressDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Otra de las direcciones registradas del cliente',
  })
  @IsUUID()
  addressId!: string;

  @ApiPropertyOptional({
    maxLength: 500,
    example: 'Me mudé temporalmente a lo de mi mamá',
    description: 'Motivo del cambio; queda asentado con la dirección anterior',
  })
  @IsOptional()
  @TextoNoVacio()
  @MaxLength(500)
  reason?: string;
}
