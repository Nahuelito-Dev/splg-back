import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ClaimStatus } from '../entities/claim.entity';
import { OrderRecordResponseDto } from '../../order/dto/order-record-response.dto';
import { UserResponseDto } from '../../users/dto/user-response.dto';

export class ClaimResponseDto {
  @ApiProperty({ format: 'uuid' }) claim_id!: string;
  @ApiProperty({ format: 'uuid' }) distributor_id!: string;
  @ApiProperty({ format: 'uuid' }) order_id!: string;
  @ApiProperty({ format: 'uuid' }) customer_id!: string;
  @ApiProperty({ example: 'Fuga de gas' }) reason!: string;
  @ApiProperty() description!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'URL firmada de la foto del reclamo (vence en minutos: pedirla de nuevo ' +
      'con `GET /claims/:id/photo`), o `null` si no tiene foto (también con el ' +
      'driver local, que no firma URLs: ahí se usa `GET /claims/:id/photo`).',
  })
  photoUrl!: string | null;
  @ApiProperty({ enum: ClaimStatus }) status!: ClaimStatus;
  @ApiProperty({ type: String, nullable: true })
  resolutionNote!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiPropertyOptional({ type: OrderRecordResponseDto })
  order?: OrderRecordResponseDto;
  @ApiPropertyOptional({ type: UserResponseDto })
  customer?: UserResponseDto;
}
