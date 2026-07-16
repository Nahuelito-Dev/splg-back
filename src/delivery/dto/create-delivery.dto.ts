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

  /**
   * Distribuidora a la que pertenece el chofer. La setea el backend según quién
   * lo crea (admin → su propia empresa; super_admin → la elegida). Sin ella el
   * chofer no entra en el dispatch de ninguna distribuidora.
   */
  @IsOptional()
  @IsUUID()
  distributorId?: string;
}
