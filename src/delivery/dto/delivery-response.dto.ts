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
  @ApiProperty({ description: 'Disponible para recibir ofertas' })
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
