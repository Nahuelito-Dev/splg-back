// user-address/dto/create-user-address.dto.ts
import {
  IsUUID,
  IsString,
  IsNumber,
  IsOptional,
  IsBoolean,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateUserAddresDto {
  @ApiProperty({ description: 'ID del usuario' })
  @IsUUID()
  user_id: string;

  @ApiProperty({ description: 'Calle y número' })
  @IsString()
  street: string;

  @ApiProperty({ description: 'Ciudad' })
  @IsString()
  city: string;

  @ApiProperty({ description: 'Código postal', required: false })
  @IsOptional()
  @IsString()
  postalCode?: string;

  @ApiProperty({ description: 'Latitud' })
  @IsString()
  latitude: string;

  @ApiProperty({ description: 'Longitud' })
  @IsString()
  longitude: string;

  @ApiProperty({
    description: 'Dirección completa formateada',
    required: false,
  })
  @IsOptional()
  @IsString()
  formattedAddress?: string;

  @ApiProperty({ description: 'Es dirección principal', default: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiProperty({ description: 'Instrucciones adicionales', required: false })
  @IsOptional()
  @IsString()
  additionalInstructions?: string;
}
