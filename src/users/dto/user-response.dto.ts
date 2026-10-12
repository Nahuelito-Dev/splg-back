import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RoleResponseDto } from '../../role/dto/role-response.dto';
import { UserAddressResponseDto } from '../../user-address/dto/user-address-response.dto';
import { DeliveryResponseDto } from '../../delivery/dto/delivery-response.dto';
import { CustomerResponseDto } from '../../customer/dto/customer-response.dto';

/**
 * El usuario tal como sale de la API. No incluye `firebase_uid`: es el
 * identificador del proveedor de identidad y ningún cliente lo usa.
 *
 * Las relaciones son opcionales: salen sólo cuando el endpoint las carga, igual
 * que cuando se devolvía la entidad.
 */
export class UserResponseDto {
  @ApiProperty({ format: 'uuid' })
  user_id!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  role_id!: string | null;

  @ApiProperty({ type: String, nullable: true })
  full_name!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    deprecated: true,
    description:
      'Obsoleto: siempre `null`. La foto de perfil es `photoUrl` (URL firmada de S3).',
  })
  selfie!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'URL firmada de la foto de perfil (se abre sin token, vence); `null` si no tiene.',
  })
  photoUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  email!: string | null;

  @ApiProperty({ type: String, nullable: true })
  phone_number!: string | null;

  @ApiProperty()
  phone_verified!: boolean;

  @ApiProperty()
  email_verified!: boolean;

  @ApiProperty()
  blocked!: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  deletedAt!: Date | null;

  @ApiPropertyOptional({ type: RoleResponseDto })
  role?: RoleResponseDto;

  @ApiPropertyOptional({ type: UserAddressResponseDto, isArray: true })
  addresses?: UserAddressResponseDto[];

  @ApiPropertyOptional({ type: DeliveryResponseDto, nullable: true })
  delivery?: DeliveryResponseDto | null;

  // Diferido: CustomerResponseDto también referencia a UserResponseDto.
  @ApiPropertyOptional({ type: () => CustomerResponseDto, nullable: true })
  customer?: CustomerResponseDto | null;
}
