import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import {
  MOTIVO_ENTREGA_MANUAL_MAX,
  MOTIVO_ENTREGA_MANUAL_MIN,
} from './update-order-status.dto';

/**
 * Body de `POST /api/v3/orders/:id/confirm-delivery`. El chofer manda el código
 * que le dice el cliente y su ubicación; el admin manda el motivo. Qué campos
 * corresponden a cada rol lo decide el caso de uso (ConfirmDeliveryV3UseCase).
 */
export class ConfirmDeliveryV3Dto {
  @ApiProperty({
    required: false,
    type: String,
    minLength: 6,
    maxLength: 6,
    pattern: '^\\d{6}$',
    example: '482913',
    description:
      'Código de 6 dígitos que el cliente ve en su app. Obligatorio para el chofer: si no tiene 6 dígitos responde 400 `DELIVERY_CODE_FORMATO` y no cuenta como intento (el formato lo valida el caso de uso, para devolver ese `code`). Para el admin es opcional e informativo: no se compara ni frena la entrega, que sale con `reason`.',
  })
  // Sin @IsString/@Matches a propósito: el formato lo valida
  // ConfirmDeliveryV3UseCase para responder `code: DELIVERY_CODE_FORMATO`.
  @IsOptional()
  code?: string | null;

  @ApiProperty({
    type: Number,
    required: false,
    example: -27.3671,
    minimum: -90,
    maximum: 90,
    description: 'Latitud del chofer al confirmar. Obligatoria para el chofer.',
  })
  @IsOptional()
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: 'Latitud: tiene que ser un número' },
  )
  @Min(-90, { message: 'Latitud: entre -90 y 90' })
  @Max(90, { message: 'Latitud: entre -90 y 90' })
  latitude?: number | null;

  @ApiProperty({
    type: Number,
    required: false,
    example: -55.8961,
    minimum: -180,
    maximum: 180,
    description:
      'Longitud del chofer al confirmar. Obligatoria para el chofer.',
  })
  @IsOptional()
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: 'Longitud: tiene que ser un número' },
  )
  @Min(-180, { message: 'Longitud: entre -180 y 180' })
  @Max(180, { message: 'Longitud: entre -180 y 180' })
  longitude?: number | null;

  @ApiProperty({
    type: Number,
    required: false,
    example: 12.5,
    minimum: 0,
    maximum: 10000,
    description: 'Precisión del GPS, en metros.',
  })
  @IsOptional()
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: 'Precisión: tiene que ser un número' },
  )
  @Min(0, { message: 'Precisión: entre 0 y 10000 metros' })
  @Max(10000, { message: 'Precisión: entre 0 y 10000 metros' })
  accuracyMeters?: number | null;

  @ApiProperty({
    type: String,
    required: false,
    minLength: MOTIVO_ENTREGA_MANUAL_MIN,
    maxLength: MOTIVO_ENTREGA_MANUAL_MAX,
    description:
      'Motivo de la entrega. Obligatorio SIEMPRE que confirma un admin o super admin (10 a 500 caracteres; 400 si falta o es corto), mande o no el `code`; el chofer no lo manda.',
    example: 'El cliente no tiene celular: confirmó por teléfono',
  })
  @IsOptional()
  @IsString({ message: 'Motivo: tiene que ser un texto' })
  reason?: string | null;
}
