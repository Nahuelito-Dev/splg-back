import { ApiProperty } from '@nestjs/swagger';
import { PromocionConPrecioDto } from './create-gascylinder.dto';

/** Un producto del catálogo tal como lo ve un visitante sin sesión. */
export class ProductoPublicoDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '10kg' })
  type!: string;

  @ApiProperty({ example: 10, description: 'Peso en kg' })
  weight!: number;

  @ApiProperty({ description: 'Precio de lista, antes de promociones' })
  price!: number;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'URL firmada de lectura corta de la imagen; `null` si no tiene.',
  })
  photoUrl!: string | null;

  @ApiProperty({
    type: PromocionConPrecioDto,
    isArray: true,
    description: 'Promociones por cantidad; vacío si no hay.',
  })
  promotions!: PromocionConPrecioDto[];

  @ApiProperty({
    description: 'Si hay unidades para vender ahora. No expone la cantidad.',
  })
  inStock!: boolean;
}

/** El catálogo público de una distribuidora. */
export class CatalogoPublicoDto {
  @ApiProperty({ example: 'demo' })
  slug!: string;

  @ApiProperty({ example: 'Distribuidora Demo' })
  name!: string;

  @ApiProperty({ type: ProductoPublicoDto, isArray: true })
  products!: ProductoPublicoDto[];
}
