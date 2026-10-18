import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserResponseDto } from '../../users/dto/user-response.dto';

/**
 * El perfil de cliente. No incluye `notification_token`: es el token del
 * dispositivo para las notificaciones push y sólo lo usa el backend.
 */
export class CustomerResponseDto {
  @ApiProperty({ format: 'uuid' })
  customer_id!: string;

  @ApiProperty({ format: 'uuid' })
  user_id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '-27.3671,-55.8961',
  })
  lat_lang!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  createdAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  deletedAt!: Date | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 20,
    description: 'Consumo promedio declarado por el cliente, en kg por mes',
  })
  avgMonthlyConsumptionKg!: number | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Id del tipo de garrafa habitual que declaró el cliente',
  })
  declaredCylinderTypeId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '10kg',
    description: 'Tipo de garrafa habitual que declaró el cliente',
  })
  declaredCylinderType!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Fecha estimada de su próxima recompra',
  })
  nextRepurchaseEstimateAt!: Date | null;

  // Diferido: UserResponseDto también referencia a CustomerResponseDto.
  @ApiPropertyOptional({ type: () => UserResponseDto })
  user?: UserResponseDto;
}
