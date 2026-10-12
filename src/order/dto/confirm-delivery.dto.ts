import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
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
  code!: string;

  @ApiProperty({
    required: false,
    minLength: 10,
    maxLength: 500,
    description:
      'Motivo de la entrega. Obligatorio (10 a 500 caracteres) si confirma un ' +
      'admin/super_admin; para el cliente no se pide y se ignora.',
    example: 'El cliente no tiene celular: confirmó por teléfono',
  })
  @IsOptional()
  @IsString()
  reason?: string;
}
