import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserResponseDto } from '../../users/dto/user-response.dto';

/**
 * El perfil de chofer. No incluye `notification_token`: es el token del
 * dispositivo para las notificaciones push y sólo lo usa el backend.
 */
export class DeliveryResponseDto {
  @ApiProperty({ format: 'uuid' }) delivery_id!: string;
  @ApiProperty({ format: 'uuid' }) distributor_id!: string;
  @ApiProperty({ format: 'uuid' }) user_id!: string;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Promedio de calificaciones',
  })
  calification!: number | null;
  @ApiProperty({ type: String, nullable: true }) latLng!: string | null;
  @ApiProperty({ type: String, nullable: true }) actual_location!:
    | string
    | null;
  @ApiProperty({ type: Number, nullable: true }) cancelledCharge!:
    | number
    | null;
  @ApiProperty() validated!: boolean;
  @ApiProperty({
    description:
      'Habilitación administrativa: false si un admin dio de baja al chofer',
  })
  isEnabled!: boolean;
  @ApiProperty({
    description: 'Presencia: true mientras el chofer está en línea en su app',
  })
  isAvailable!: boolean;
  @ApiProperty({
    deprecated: true,
    description:
      'Deprecado, se mantiene por compatibilidad con paneles existentes: ' +
      'alias de `isEnabled` (NO de `isAvailable`). Usar `isEnabled` para la ' +
      'habilitación e `isAvailable` para si está en línea.',
  })
  isActive!: boolean;
  @ApiProperty() balance!: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  createdAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  deletedAt!: Date | null;

  // Diferido: UserResponseDto también referencia a DeliveryResponseDto.
  @ApiPropertyOptional({
    type: () => UserResponseDto,
    description: 'La persona, con su rol: sale en las lecturas del panel',
  })
  user?: UserResponseDto;
}
