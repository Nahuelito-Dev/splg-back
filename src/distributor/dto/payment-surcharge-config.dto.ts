import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, Max, Min } from 'class-validator';
import {
  SURCHARGE_PERCENTAGE_MAX,
  SURCHARGE_PERCENTAGE_MIN,
} from '../payment-surcharge-settings';

const RANGO = `${SURCHARGE_PERCENTAGE_MIN} a ${SURCHARGE_PERCENTAGE_MAX} %, hasta 2 decimales`;

/**
 * Cuerpo de `PUT /v2/payment-surcharges`: reemplaza la configuración, así que
 * `mercadoPagoPercentage` y `cashPercentage` son obligatorios (omitir uno o
 * mandar `null` es 400).
 */
export class PaymentSurchargeConfigDto {
  @ApiProperty({
    description: `Recargo por Mercado Pago, en % (${RANGO}). Obligatorio. Valor por omisión del sistema: 10`,
    example: 10,
  })
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(SURCHARGE_PERCENTAGE_MIN)
  @Max(SURCHARGE_PERCENTAGE_MAX)
  mercadoPagoPercentage!: number;

  @ApiProperty({
    description: `Recargo por efectivo, en % (${RANGO}). Obligatorio. Valor por omisión del sistema: 0`,
    example: 0,
  })
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(SURCHARGE_PERCENTAGE_MIN)
  @Max(SURCHARGE_PERCENTAGE_MAX)
  cashPercentage!: number;
}

/** Respuesta de `GET`/`PUT /v2/payment-surcharges`. */
export class PaymentSurchargeConfigResponseDto {
  @ApiProperty({ example: 10 }) mercadoPagoPercentage!: number;
  @ApiProperty({ example: 0 }) cashPercentage!: number;

  @ApiProperty({
    description:
      'true si rigen los valores por omisión (no configuró nada o todo coincide con ellos)',
    example: true,
  })
  isDefault!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  updatedAt!: Date | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  updatedByUserId!: string | null;
}
