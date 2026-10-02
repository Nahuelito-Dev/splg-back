import {
  IsString,
  IsNotEmpty,
  IsInt,
  IsOptional,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTimeSlotDto {
  @ApiProperty({ example: 'Mañana', description: 'Nombre del turno' })
  @IsString()
  @IsNotEmpty()
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
    description: 'Capacidad máxima de pedidos (columna con default en la base)',
  })
  @IsInt()
  @IsOptional()
  capacity?: number;
}
