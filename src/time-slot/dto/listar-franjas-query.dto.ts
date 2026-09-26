import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ListarFranjasQueryDto {
  @ApiPropertyOptional({
    description: 'Slug o id de la distribuidora (sólo super_admin)',
    example: 'jeny-gas',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  distributor?: string;
}
