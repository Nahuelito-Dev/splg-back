import { ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { DistributorStatus } from '../../../distributor/entities/distributor.entity';
import { ScheduledTasksConfigDto } from '../../../distributor/dto/scheduled-tasks-config.dto';

const DIA = /^\d{4}-\d{2}-\d{2}$/;

/** `'true'`/`'false'` de la query a booleano; cualquier otra cosa no valida. */
const aBooleano = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/** Período de las métricas: días argentinos, extremos inclusivos. */
export class PlatformRangeQueryDto {
  @ApiPropertyOptional({
    example: '2026-11-01',
    description:
      'Desde (día en hora argentina, AAAA-MM-DD). Sin `from`: el primero del mes de `to` (o del mes en curso).',
  })
  @IsOptional()
  @Matches(DIA)
  @IsDateString({ strict: true })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-11-14',
    description:
      'Hasta (día en hora argentina, inclusive, AAAA-MM-DD). Sin `to`: hoy. El período abarca hasta 366 días.',
  })
  @IsOptional()
  @Matches(DIA)
  @IsDateString({ strict: true })
  to?: string;
}

export class PlatformCompaniesQueryDto extends PlatformRangeQueryDto {
  @ApiPropertyOptional({
    description:
      'true: sólo las empresas propias de la plataforma; false: sólo las de clientes',
  })
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  ownedByPlatform?: boolean;

  @ApiPropertyOptional({ enum: DistributorStatus })
  @IsOptional()
  @IsEnum(DistributorStatus)
  status?: DistributorStatus;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

export class PlatformMonthQueryDto {
  @ApiPropertyOptional({
    example: '2026-11',
    description:
      'Mes calendario (AAAA-MM, hora argentina). Sin `month`: el mes en curso.',
  })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  month?: string;
}

export class PlatformActivityQueryDto {
  @ApiPropertyOptional({
    example: '2026-11-01T00:00:00-03:00',
    description: 'Desde este instante (ISO 8601, inclusive)',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-11-15T00:00:00-03:00',
    description: 'Hasta este instante (ISO 8601, exclusivo)',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Quién lo hizo' })
  @IsOptional()
  @IsUUID('4')
  actorUserId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Sobre qué empresa' })
  @IsOptional()
  @IsUUID('4')
  distributorId?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

/**
 * Cuerpo de `PUT /v2/platform/companies/{id}/scheduled-tasks`: las cuatro
 * frecuencias (lo que no viene vuelve a su valor por omisión). La hora del
 * aviso de flota es de la empresa y no se acepta acá.
 */
export class PlatformScheduledTasksDto extends OmitType(
  ScheduledTasksConfigDto,
  ['fleetAlertHour'] as const,
) {}
