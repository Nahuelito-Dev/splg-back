import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';

/** Descuento máximo de una promoción: al 100 % el producto quedaría gratis. */
export const DESCUENTO_MAXIMO_PROMOCION = 99;
/** Peso máximo de una garrafa, en kg. */
export const PESO_MAXIMO_KG = 1000;
/** Precio máximo de una garrafa. */
export const PRECIO_MAXIMO = 10_000_000;

/** Una promoción por cantidad: desde N unidades, un porcentaje de descuento. */
export class PromocionDto {
  @ApiProperty({ description: 'Unidades desde las que aplica', example: 3 })
  @IsInt({ message: 'quantity debe ser un número entero' })
  @Min(2, { message: 'una promoción por cantidad arranca en 2 unidades' })
  quantity!: number;

  @ApiProperty({
    description: 'Descuento, en porcentaje (hasta 99, 2 decimales)',
    example: 10,
    maximum: 99,
  })
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'discountPercentage admite hasta 2 decimales' },
  )
  @IsPositive({ message: 'discountPercentage debe ser mayor que 0' })
  @Max(DESCUENTO_MAXIMO_PROMOCION, {
    message: `discountPercentage no puede superar ${DESCUENTO_MAXIMO_PROMOCION}`,
  })
  discountPercentage!: number;
}

/** Una promoción tal como sale del catálogo: con el precio unitario que cobra el pedido. */
export class PromocionConPrecioDto extends PromocionDto {
  @ApiProperty({
    description:
      'Precio unitario con esta promoción, redondeado a centavos con la misma regla que cobra el pedido. No incluye el recargo de zona ni el del medio de pago, que se aplican sobre el total del pedido',
    example: 13409.99,
  })
  unitPrice!: number;
}

export class CreateGasCylinderDto {
  @ApiProperty({ description: 'Tipo de garrafa (10, 15, 45 kg)' })
  @TextoNoVacio()
  @MaxLength(50)
  type!: string;

  @ApiProperty({ description: 'Peso en kg (hasta 1000, 2 decimales)' })
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'weight admite hasta 2 decimales' },
  )
  @IsPositive({ message: 'weight debe ser mayor que 0' })
  @Max(PESO_MAXIMO_KG, {
    message: `weight no puede superar ${PESO_MAXIMO_KG} kg`,
  })
  weight!: number;

  @ApiProperty({
    description: 'Precio unitario (hasta 10.000.000, 2 decimales)',
  })
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'price admite hasta 2 decimales' },
  )
  @IsPositive({ message: 'price debe ser mayor que 0' })
  @Max(PRECIO_MAXIMO, { message: `price no puede superar ${PRECIO_MAXIMO}` })
  price!: number;

  @ApiPropertyOptional({
    description:
      'Stock vendible inicial: se registra como físico del depósito predeterminado. ' +
      'En la edición (PATCH /gascylinder/{id}) no se admite: responde 400; el stock cambia con PATCH /gascylinder/{id}/stock.',
  })
  @IsOptional()
  @IsInt({ message: 'stock debe ser un número entero' })
  @Min(0, { message: 'stock no puede ser negativo' })
  stock?: number;

  @ApiPropertyOptional({ description: 'Descripción' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Promociones por cantidad (ej: 3 unidades 10% off)',
    type: PromocionDto,
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PromocionDto)
  promotions?: PromocionDto[];
}
