// gas-cylinder/dto/update-gas-cylinder.dto.ts
import { PartialType } from '@nestjs/swagger';
import { CreateGasCylinderDto } from './create-gascylinder.dto';
import { IsOptional, IsArray } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateGasCylinderDto extends PartialType(CreateGasCylinderDto) {
    @ApiProperty({
        description: 'Promociones por cantidad (ej: 3 unidades 10% off)',
        required: false,
        example: [{ quantity: 3, discountPercentage: 10 }],
    })
    @IsOptional()
    @IsArray()
    promotions?: { quantity: number; discountPercentage: number }[];
}