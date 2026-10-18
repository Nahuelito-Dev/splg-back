import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/** Tope duro de garrafas por mes; el rango "razonable" se controla aparte. */
export const GARRAFAS_POR_MES_MAXIMAS = 1000;

/**
 * Consumo mensual declarado durante el registro (CU-143). Si el cliente prefiere
 * no declararlo, el campo se omite y el registro sigue igual.
 */
export class DeclareConsumptionDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Tipo de garrafa habitual (del catálogo de una distribuidora)',
  })
  @IsUUID()
  cylinderTypeId!: string;

  @ApiProperty({
    example: 2,
    description: 'Garrafas de ese tipo que consume por mes (admite decimales)',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(GARRAFAS_POR_MES_MAXIMAS)
  quantityPerMonth!: number;

  @ApiPropertyOptional({
    default: false,
    description:
      'true para aceptar un consumo fuera del rango razonable (5 a 500 kg por mes) después de que el sistema pidió confirmación',
  })
  @IsOptional()
  @IsBoolean()
  confirmOutOfRange?: boolean;
}
