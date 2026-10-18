import { ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';
import {
  DeclareConsumptionDto,
  GARRAFAS_POR_MES_MAXIMAS,
} from './declare-consumption.dto';

/**
 * Corrección del consumo declarado (CU-144). El tipo de garrafa es opcional si
 * el cliente ya declaró uno: se mantiene.
 */
export class UpdateConsumptionDto extends OmitType(DeclareConsumptionDto, [
  'cylinderTypeId',
  'quantityPerMonth',
] as const) {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Tipo de garrafa habitual. Obligatorio si el cliente nunca declaró uno',
  })
  @IsOptional()
  @IsUUID()
  cylinderTypeId?: string;

  @ApiPropertyOptional({
    example: 2,
    description:
      'Garrafas de ese tipo por mes (0,01 a 1000, hasta 2 decimales). Si se omite, se manda `cylinderTypeId` y se mantiene el consumo en kg por mes',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(GARRAFAS_POR_MES_MAXIMAS)
  quantityPerMonth?: number;
}
