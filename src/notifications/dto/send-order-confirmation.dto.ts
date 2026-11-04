import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

/** Aviso de confirmación de un pedido al cliente que lo hizo. */
export class SendOrderConfirmationDto {
  @ApiProperty({ description: 'Identificador del cliente destinatario' })
  @IsUUID('4')
  customerId!: string;

  @ApiProperty({ description: 'Pedido que se confirma' })
  @IsUUID('4')
  orderId!: string;

  @ApiPropertyOptional({
    description:
      'Token de FCM. Si no viene, se busca el que tenga guardado el cliente.',
  })
  @IsOptional()
  @IsString()
  token?: string;
}
