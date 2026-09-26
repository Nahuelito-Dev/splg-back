// src/car/dto/create-car.dto.ts - VERSIÓN MEJORADA
import {
  IsUUID,
  IsOptional,
  IsString,
  IsInt,
  MinLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateCarDto {
  @ApiProperty({ description: 'User ID' })
  @IsUUID()
  user_id!: string;

  @ApiProperty({
    description: 'Car type (Moto, Auto, Camioneta)',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  type_car?: string;

  @ApiProperty({ description: 'Car capacity in kg', required: false })
  @IsOptional()
  @IsInt()
  car_capacity?: number;

  @ApiProperty({ description: 'Car patent number', required: false })
  @IsOptional()
  @IsString()
  @MinLength(4)
  car_patent?: string;

  @ApiProperty({ description: 'Car brand', required: false })
  @IsOptional()
  @IsString()
  car_brand?: string;

  @ApiProperty({ description: 'Car model', required: false })
  @IsOptional()
  @IsString()
  car_model?: string;

  @ApiProperty({ description: 'Car year', required: false })
  @IsOptional()
  @IsInt()
  car_year?: number;

  @ApiProperty({ description: 'Car color', required: false })
  @IsOptional()
  @IsString()
  car_color?: string;
}
