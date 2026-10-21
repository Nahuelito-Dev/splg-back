import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';

/** Tope de pedidos por franja y día. */
export const CAPACIDAD_MAXIMA_FRANJA = 10000;

export class CreateTimeSlotDto {
  @ApiProperty({ example: 'Mañana', description: 'Nombre del turno' })
  @TextoNoVacio()
  @MaxLength(50)
  name!: string;

  @ApiProperty({ example: '09:00', description: 'Hora de inicio (HH:MM)' })
  @IsString()
  @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, {
    message: 'startTime must be in HH:MM format',
  })
  startTime!: string;

  @ApiProperty({ example: '13:00', description: 'Hora de fin (HH:MM)' })
  @IsString()
  @Matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, {
    message: 'endTime must be in HH:MM format',
  })
  endTime!: string;

  @ApiPropertyOptional({
    example: 50,
    default: 50,
    description:
      'Capacidad máxima de pedidos, de 1 a 10000 (columna con default en la base)',
    minimum: 1,
    maximum: CAPACIDAD_MAXIMA_FRANJA,
  })
  @IsInt()
  @Min(1)
  @Max(CAPACIDAD_MAXIMA_FRANJA)
  @IsOptional()
  capacity?: number;
}
