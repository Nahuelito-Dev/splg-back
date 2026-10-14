import {
  IsUUID,
  IsString,
  IsOptional,
  IsBoolean,
  IsLatitude,
  IsLongitude,
  IsEnum,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PrecisionDeGeocodificacion } from '../entities/user-address.entity';

export class CreateUserAddressDto {
  @ApiPropertyOptional({
    description:
      'Dueño de la dirección. Sólo lo usa el administrador general (obligatorio para él). Un cliente o un chofer crea siempre para sí mismo con el de su token: puede omitirlo; si lo manda y es el de otro usuario, 403.',
  })
  @IsOptional()
  @IsUUID()
  user_id?: string;

  @ApiProperty({ description: 'Calle y número' })
  @IsString()
  street!: string;

  @ApiProperty({ description: 'Ciudad' })
  @IsString()
  city!: string;

  @ApiProperty({ description: 'Código postal', required: false })
  @IsOptional()
  @IsString()
  postalCode?: string;

  @ApiProperty({ description: 'Latitud', example: '-27.3671' })
  @IsLatitude({ message: 'latitude debe ser una latitud válida' })
  latitude!: string;

  @ApiProperty({ description: 'Longitud', example: '-55.8961' })
  @IsLongitude({ message: 'longitude debe ser una longitud válida' })
  longitude!: string;

  @ApiPropertyOptional({ description: 'Piso', example: '3' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  floor?: string;

  @ApiPropertyOptional({ description: 'Departamento', example: 'B' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  apartment?: string;

  @ApiPropertyOptional({
    description: 'Identificador del lugar en el servicio de mapas',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  placeId?: string;

  @ApiPropertyOptional({
    enum: PrecisionDeGeocodificacion,
    description: 'Con qué precisión se resolvió la dirección en el mapa',
  })
  @IsOptional()
  @IsEnum(PrecisionDeGeocodificacion, {
    message: 'geocodePrecision debe ser exact, approximate o unresolved',
  })
  geocodePrecision?: PrecisionDeGeocodificacion;

  @ApiProperty({
    description: 'Dirección completa formateada',
    required: false,
  })
  @IsOptional()
  @IsString()
  formattedAddress?: string;

  @ApiPropertyOptional({
    description: 'Es dirección principal',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiProperty({ description: 'Instrucciones adicionales', required: false })
  @IsOptional()
  @IsString()
  additionalInstructions?: string;
}
