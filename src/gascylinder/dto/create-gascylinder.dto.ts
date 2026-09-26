import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** Una promoción por cantidad: desde N unidades, un porcentaje de descuento. */
export class PromocionDto {
  @ApiProperty({ description: 'Unidades desde las que aplica', example: 3 })
  @IsInt({ message: 'quantity debe ser un número entero' })
  @Min(2, { message: 'una promoción por cantidad arranca en 2 unidades' })
  quantity!: number;

  @ApiProperty({ description: 'Descuento, en porcentaje', example: 10 })
  @IsPositive({ message: 'discountPercentage debe ser mayor que 0' })
  @Max(100, { message: 'discountPercentage no puede superar 100' })
  discountPercentage!: number;
}

export class CreateGasCylinderDto {
  @ApiProperty({ description: 'Tipo de garrafa (10, 15, 45 kg)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  type!: string;

  @ApiProperty({ description: 'Peso en kg' })
  @IsPositive({ message: 'weight debe ser mayor que 0' })
  weight!: number;

  @ApiProperty({ description: 'Precio unitario' })
  @IsPositive({ message: 'price debe ser mayor que 0' })
  price!: number;

  @ApiPropertyOptional({ description: 'Stock disponible' })
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
