import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ValidateNested } from 'class-validator';
import { PagoAlCerrar } from './pay-task.dto';
import { MAXIMO_ODOMETRO_KM } from '../../common/constants/odometro';

/** CU-141: registrar que un mantenimiento/habilitación se hizo. */
export class CloseFleetTaskDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-26T13:00:00.000Z',
    description: 'Cuándo se hizo (o se renovó)',
  })
  @IsDateString()
  performedAt!: string;

  @ApiPropertyOptional({ description: 'Kilometraje del vehículo al hacerlo' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAXIMO_ODOMETRO_KM)
  odometerKm?: number;

  @ApiPropertyOptional({ example: 45000.5 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  cost?: number;

  @ApiPropertyOptional({ description: 'Si cambió respecto al de la tarea' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  provider?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

/** Cierre v2: además, «lo pagué ahora» desde una caja. */
export class CloseFleetTaskV2Dto extends CloseFleetTaskDto {
  @ApiPropertyOptional({
    type: PagoAlCerrar,
    description:
      'Paga la tarea en el mismo acto del cierre (necesita un costo mayor que cero)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PagoAlCerrar)
  payment?: PagoAlCerrar;
}
