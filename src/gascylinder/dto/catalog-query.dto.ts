import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../../common/dtos/pagination.dto';

/**
 * La distribuidora del catálogo público, por slug (`demo`) o uuid. Sin
 * ella se usa la distribuidora por defecto, así la app previa al
 * multi-tenant sigue viendo un catálogo coherente.
 */
export class DistribuidoraQueryDto {
  @ApiPropertyOptional({ example: 'demo' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  distributor?: string;
}

/** Query del catálogo público: paginación y distribuidora. */
export class CatalogQueryDto extends PaginationDto {
  @ApiPropertyOptional({ example: 'demo' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  distributor?: string;
}

/** `GET /gascylinder/type/:type`. */
export class TipoParamDto {
  @ApiPropertyOptional({ example: '10kg' })
  @IsString()
  @MaxLength(50)
  type!: string;
}
