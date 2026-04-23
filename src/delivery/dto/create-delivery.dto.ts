// delivery/dto/create-delivery.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import {
  IsUUID,
  IsOptional,
  IsNumber,
  IsString,
  IsBoolean,
  MinLength,
  IsEmail,
  IsNotEmpty,
} from 'class-validator';

export class CreateDeliveryDto {
  // Datos del User
  @IsString()
  @MinLength(2)
  full_name: string;

  @IsString()
  phone_number: string;

  @ApiProperty({ description: 'User email' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ description: 'User password' })
  @IsString()
  @IsNotEmpty()
  password: string;

  @IsOptional()
  @IsString()
  selfie?: string;

  // Datos específicos del Delivery
  @IsOptional()
  @IsNumber()
  calification?: number;

  @IsOptional()
  @IsString()
  latLng?: string;

  @IsOptional()
  @IsString()
  actual_location?: string;

  @IsOptional()
  @IsBoolean()
  validated?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
