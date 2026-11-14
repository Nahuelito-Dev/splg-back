import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { RoutePlanningHoliday } from '../../../order/entities/route-planning-holiday.entity';

const FORMATO_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MENSAJE_FORMATO = 'La fecha tiene que tener el formato AAAA-MM-DD';
const MENSAJE_FECHA = 'La fecha no es válida';

export class CreateRoutePlanningHolidayDto {
  @ApiProperty({
    example: '2026-12-08',
    description: 'Día feriado (AAAA-MM-DD, hora argentina): hoy o más adelante',
  })
  @Matches(FORMATO_FECHA, { message: MENSAJE_FORMATO })
  @IsDateString({ strict: true }, { message: MENSAJE_FECHA })
  date!: string;

  @ApiProperty({
    example: 'Inmaculada Concepción',
    minLength: 2,
    maxLength: 120,
  })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Matches(/\S.*\S/, { message: 'Escribí una descripción del feriado' })
  description!: string;
}

export class ListRoutePlanningHolidaysQueryDto {
  @ApiPropertyOptional({
    example: '2026-11-01',
    description: 'Desde (AAAA-MM-DD; por omisión, hoy)',
  })
  @IsOptional()
  @Matches(FORMATO_FECHA, { message: MENSAJE_FORMATO })
  @IsDateString({ strict: true }, { message: MENSAJE_FECHA })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-12-31',
    description: 'Hasta (AAAA-MM-DD; sin tope si no viene)',
  })
  @IsOptional()
  @Matches(FORMATO_FECHA, { message: MENSAJE_FORMATO })
  @IsDateString({ strict: true }, { message: MENSAJE_FECHA })
  to?: string;
}

export class RoutePlanningHolidayDto {
  @ApiProperty({ format: 'uuid' })
  holidayId!: string;

  @ApiProperty({ example: '2026-12-08' })
  date!: string;

  @ApiProperty({ example: 'Inmaculada Concepción' })
  description!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  static de(f: RoutePlanningHoliday): RoutePlanningHolidayDto {
    return {
      holidayId: f.holidayId,
      date: f.date,
      description: f.description,
      createdAt: f.createdAt.toISOString(),
    };
  }
}
