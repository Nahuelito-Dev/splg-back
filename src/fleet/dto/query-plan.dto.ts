import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { MaintenanceSubject } from '../entities/maintenance-plan.entity';

export class QueryFleetPlanDto {
  @ApiPropertyOptional({ enum: MaintenanceSubject })
  @IsOptional()
  @IsEnum(MaintenanceSubject)
  subject?: MaintenanceSubject;

  @ApiPropertyOptional({
    description: 'Sin este filtro trae activos e inactivos',
  })
  @IsOptional()
  // Query param siempre llega como string ("true"/"false"); `Boolean("false")`
  // da `true`, por eso se compara el texto en vez de usar `@Type(() => Boolean)`.
  @Transform(
    ({ value }: { value: unknown }) => value === true || value === 'true',
  )
  @IsBoolean()
  isActive?: boolean;
}
