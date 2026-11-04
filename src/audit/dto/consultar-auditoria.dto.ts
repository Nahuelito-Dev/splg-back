import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AuditResult } from '../entities/audit-log.entity';

/** Filtros de la consulta del registro de auditoría (CU-152). */
export class ConsultarAuditoriaDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Quién hizo la operación',
  })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @ApiPropertyOptional({ example: 'orders', description: 'Tipo de recurso' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  resource?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Un recurso puntual' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  resourceId?: string;

  @ApiPropertyOptional({ enum: AuditResult })
  @IsOptional()
  @IsEnum(AuditResult)
  result?: AuditResult;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate({ message: 'desde debe ser una fecha' })
  desde?: Date;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate({ message: 'hasta debe ser una fecha' })
  hasta?: Date;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}
