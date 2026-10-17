import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsPositive, Max, Min } from 'class-validator';

/** `GET /cylinders/vigencia/proximos-a-vencer`. */
export class QueryExpiringCylindersDto {
  @ApiPropertyOptional({
    default: 30,
    minimum: 1,
    maximum: 365,
    description: 'Ventana en días: los que vencen de hoy a hoy + `days`.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  @Type(() => Number)
  days?: number;

  @ApiPropertyOptional({
    default: 100,
    maximum: 500,
    description: 'Tamaño de página de cada grupo.',
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  @Max(500)
  @Type(() => Number)
  limit?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  offset?: number;
}
