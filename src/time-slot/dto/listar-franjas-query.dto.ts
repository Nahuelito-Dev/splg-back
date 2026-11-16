import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class ListarFranjasQueryDto {
  @ApiPropertyOptional({
    description: 'Slug o id de la distribuidora (sólo super_admin)',
    example: 'demo',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  distributor?: string;

  @ApiPropertyOptional({
    type: Boolean,
    default: false,
    description:
      'true: incluye también las franjas dadas de baja (para verlas y reactivarlas con `PATCH {isActive:true}`). Por defecto sólo las activas.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  includeInactive?: boolean;
}
