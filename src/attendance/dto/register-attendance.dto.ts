import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, MaxLength } from 'class-validator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';

export class RegisterAttendanceDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-03-02T11:00:00.000Z',
  })
  @IsDateString()
  checkInAt!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    example: '2026-03-02T19:30:00.000Z',
    description: 'Si la jornada ya terminó. Sin egreso queda abierta.',
  })
  @IsOptional()
  @IsDateString()
  checkOutAt?: string;
}

/** Corrige el ingreso y/o el egreso de una jornada; la nota que explica el cambio es obligatoria. */
export class CorrectAttendanceDto {
  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @IsDateString()
  checkInAt?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @IsDateString()
  checkOutAt?: string;

  @ApiProperty({ example: 'Olvidó marcar la salida', maxLength: 500 })
  @TextoNoVacio()
  @MaxLength(500)
  notes!: string;
}
