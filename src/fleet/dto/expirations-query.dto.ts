import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class FleetExpirationsQueryDto {
  @ApiPropertyOptional({
    default: 30,
    minimum: 0,
    maximum: 365,
    description:
      'Ventana en días: trae lo vencido y lo que vence dentro de esta cantidad de días',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  withinDays: number = 30;
}
