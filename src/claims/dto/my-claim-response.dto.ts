import { ApiProperty } from '@nestjs/swagger';
import { ClaimStatus } from '../entities/claim.entity';
import { OrderStatus } from '../../order/entities/order.entity';

/** El pedido reclamado, resumido. */
export class MyClaimOrderDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ enum: OrderStatus }) status!: OrderStatus;
  @ApiProperty({ example: 14900 }) totalAmount!: number;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-10-12',
    description: 'Fecha de entrega agendada, o `null` si no es agendado',
  })
  scheduledDate!: string | null;
}

/** Un reclamo visto por el cliente que lo hizo (`GET /claims/mine`). */
export class MyClaimResponseDto {
  @ApiProperty({ format: 'uuid' }) claimId!: string;
  @ApiProperty({ enum: ClaimStatus }) status!: ClaimStatus;
  @ApiProperty({ example: 'Fuga de gas' }) reason!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: MyClaimOrderDto }) order!: MyClaimOrderDto;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'URL firmada de la foto del reclamo (vence en minutos: pedirla de nuevo ' +
      'con `GET /claims/:id/photo`), o `null` si no tiene foto.',
  })
  photoUrl!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Nota con la que se resolvió o rechazó, o `null` si sigue abierto',
  })
  resolutionNote!: string | null;
}
