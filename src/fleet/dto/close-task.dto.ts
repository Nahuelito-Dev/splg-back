import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

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
