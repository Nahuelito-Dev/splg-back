import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { SupportSessionStatus } from '../../domain/support-session.enums';

/** Paginación de los listados del modo soporte. */
export class SupportPaginationDto {
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

/** Filtros del historial de la empresa (`GET /v2/support-access`). */
export class QuerySupportAccessDto extends SupportPaginationDto {
  @ApiPropertyOptional({ enum: SupportSessionStatus })
  @IsOptional()
  @IsEnum(SupportSessionStatus)
  status?: SupportSessionStatus;
}

/** Filtros del historial de la plataforma (`GET /v2/support-sessions`). */
export class QuerySupportSessionsDto extends QuerySupportAccessDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'La empresa' })
  @IsOptional()
  @IsUUID('4')
  distributorId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'El administrador general que pidió',
  })
  @IsOptional()
  @IsUUID('4')
  requestedBy?: string;

  @ApiPropertyOptional({
    description: 'Desde (ISO 8601, sobre la fecha del pedido)',
    example: '2026-11-01T00:00:00Z',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({
    description: 'Hasta (ISO 8601, sobre la fecha del pedido)',
    example: '2026-11-30T23:59:59Z',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}
