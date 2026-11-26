import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { FailedVisitReason, RevisitStatus } from '../domain/nueva-visita';

export const FILTROS_DE_ESTADO = [
  ...Object.values(RevisitStatus),
  'open',
  'all',
];

/** Filtros del listado de pedidos con visitas fallidas. */
export class QueryFailedVisitsDto {
  @ApiPropertyOptional({
    enum: FILTROS_DE_ESTADO,
    default: 'open',
    description:
      '`open` (por omisión): pedidos pendientes con una nueva visita sin cumplir; `awaiting_admin`, `proposed`, `confirmed`: sólo ese estado entre los abiertos; `all`: todos los que tuvieron una visita fallida, también los ya entregados o cancelados',
  })
  @IsOptional()
  @IsIn(FILTROS_DE_ESTADO)
  status?: string = 'open';

  @ApiPropertyOptional({ enum: FailedVisitReason })
  @IsOptional()
  @IsEnum(FailedVisitReason)
  reason?: FailedVisitReason;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    description: 'Última visita fallida desde este día (inclusive)',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    description: 'Última visita fallida hasta este día (inclusive)',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @ApiPropertyOptional({
    description: 'Nombre del cliente o final del número de pedido',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  term?: string;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}
