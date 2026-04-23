import { Type } from 'class-transformer';
import { IsOptional, IsPositive, IsString, Max } from 'class-validator';

export class PaginationDto {
  @IsOptional()
  @IsPositive()
  @Type(() => Number)
  @Max(100)
  limit?: number = 10;

  @IsOptional()
  @Type(() => Number)
  offset?: number = 0;

  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @IsPositive()
  @Type(() => Number)
  page?: number = 1;

  // --- AGREGA ESTO ---
  // Esto permite que el backend acepte ?term=algo sin tirar error 400
  @IsOptional()
  @IsString()
  term?: string;
}
