import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString } from 'class-validator';

/**
 * Consulta de disponibilidad de franjas para una fecha.
 *
 * La fecha se valida acá y no más adelante: antes el parámetro llegaba como
 * string sin mirar, y una fecha vacía viajaba hasta Postgres, que respondía
 * `invalid input syntax for type date: ""` y salía un 500.
 */
export class AvailabilityQueryDto {
  @ApiProperty({
    description: 'Fecha a consultar, en formato YYYY-MM-DD',
    example: '2026-10-15',
  })
  @IsDateString(
    { strict: false },
    { message: 'date debe ser una fecha en formato YYYY-MM-DD' },
  )
  date!: string;

  @ApiPropertyOptional({
    description: 'Distribuidora, por slug o por id',
    example: 'demo',
  })
  @IsOptional()
  @IsString()
  distributor?: string;
}
