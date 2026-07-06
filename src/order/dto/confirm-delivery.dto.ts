import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body de `POST /orders/:id/confirm-delivery`. El cliente escanea el QR que
 * muestra el chofer al llegar y envía el código leído; el backend lo valida
 * contra `order.deliveryCode` (ver ConfirmDeliveryUseCase).
 */
export class ConfirmDeliveryDto {
  @ApiProperty({
    description: 'Código secreto de entrega leído del QR que muestra el chofer',
    example: 'A1B2C3D4E5',
  })
  @IsString()
  @IsNotEmpty()
  code: string;
}
