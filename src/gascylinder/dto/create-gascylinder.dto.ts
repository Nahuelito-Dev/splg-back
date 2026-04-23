// gas-cylinder/dto/create-gas-cylinder.dto.ts
import { IsString, IsNumber, IsOptional, IsArray } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateGasCylinderDto {
  @ApiProperty({ description: 'Tipo de garrafa (10, 15, 45 kg)' })
  @IsString()
  type: string;

  @ApiProperty({ description: 'Peso en kg' })
  @IsNumber()
  weight: number;

  @ApiProperty({ description: 'Precio unitario' })
  @IsNumber()
  price: number;

  @ApiProperty({ description: 'Stock disponible', required: false })
  @IsOptional()
  @IsNumber()
  stock?: number;

  @ApiProperty({ description: 'Descripción', required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'Promociones por cantidad (ej: 3 unidades 10% off)',
    required: false,
    example: [{ quantity: 3, discountPercentage: 10 }],
  })
  @IsOptional()
  @IsArray()
  promotions?: { quantity: number; discountPercentage: number }[];
}
