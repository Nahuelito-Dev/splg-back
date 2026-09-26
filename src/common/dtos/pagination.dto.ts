import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, IsPositive, IsString, Max } from 'class-validator';

export class PaginationDto {
  @ApiPropertyOptional({ default: 10, maximum: 100 })
  @IsOptional()
  @IsPositive()
  @Type(() => Number)
  @Max(100)
  limit?: number = 10;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  offset?: number = 0;

  @ApiPropertyOptional({ description: 'Filtra por tipo de rol' })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsPositive()
  @Type(() => Number)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Texto a buscar' })
  @IsOptional()
  @IsString()
  term?: string;
}
