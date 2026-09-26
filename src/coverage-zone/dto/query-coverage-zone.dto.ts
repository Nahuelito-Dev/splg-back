import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

export class QueryCoverageZoneDto {
  @ApiPropertyOptional({
    default: false,
    description: 'Trae también las zonas inactivas (no borradas)',
  })
  @IsOptional()
  // Query param siempre llega como string ("true"/"false"); `Boolean("false")`
  // da `true`, por eso se compara el texto en vez de usar `@Type(() => Boolean)`.
  @Transform(
    ({ value }: { value: unknown }) => value === true || value === 'true',
  )
  @IsBoolean()
  includeInactive?: boolean;
}
