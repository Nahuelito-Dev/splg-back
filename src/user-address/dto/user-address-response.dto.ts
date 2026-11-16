import { PrecisionDeGeocodificacion } from '../entities/user-address.entity';
import { ApiProperty } from '@nestjs/swagger';

export class UserAddressResponseDto {
  @ApiProperty({ format: 'uuid' })
  address_id!: string;

  @ApiProperty({ format: 'uuid' })
  user_id!: string;

  @ApiProperty({ example: 'Av. Mitre 1234' })
  street!: string;

  @ApiProperty({ example: 'Posadas' })
  city!: string;

  @ApiProperty({ type: String, nullable: true })
  postalCode!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '-27.3671' })
  latitude!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '-55.8961' })
  longitude!: string | null;

  @ApiProperty({ type: String, nullable: true })
  floor!: string | null;

  @ApiProperty({ type: String, nullable: true })
  apartment!: string | null;

  @ApiProperty({ type: String, nullable: true })
  placeId!: string | null;

  @ApiProperty({ enum: PrecisionDeGeocodificacion })
  geocodePrecision!: PrecisionDeGeocodificacion;

  @ApiProperty({ type: String, nullable: true })
  formattedAddress!: string | null;

  @ApiProperty()
  isDefault!: boolean;

  @ApiProperty({ type: String, nullable: true })
  additionalInstructions!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}
