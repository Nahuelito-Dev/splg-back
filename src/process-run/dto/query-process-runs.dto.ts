import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { ProcessName, ProcessRunStatus } from '../domain/process-catalog';

export class QueryProcessRunsDto {
  @ApiPropertyOptional({ enum: ProcessName, description: 'Un proceso' })
  @IsOptional()
  @IsEnum(ProcessName)
  process?: ProcessName;

  @ApiPropertyOptional({ enum: ProcessRunStatus })
  @IsOptional()
  @IsEnum(ProcessRunStatus)
  status?: ProcessRunStatus;

  @ApiPropertyOptional({
    example: '2026-11-01',
    description:
      'Corridas que arrancaron desde este instante (ISO 8601; un día suelto es 00:00 UTC)',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-11-03T23:59:59Z',
    description: 'Corridas que arrancaron hasta este instante (ISO 8601)',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

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
