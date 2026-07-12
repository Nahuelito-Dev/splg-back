import { IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/dtos/pagination.dto';

/**
 * Query del catálogo público: paginación + selección de distribuidora (tenant).
 * `distributor` puede ser el slug (ej: `jeny-gas`) o el uuid de la distribuidora.
 * Sin él, se devuelven productos de todas las distribuidoras (modo transición).
 */
export class CatalogQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  distributor?: string;
}
