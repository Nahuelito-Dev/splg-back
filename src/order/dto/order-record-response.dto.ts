import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserResponseDto } from '../../users/dto/user-response.dto';
import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
} from '../entities/order.entity';

/**
 * El pedido tal como está registrado, cuando viaja anidado dentro de otro
 * recurso (un reclamo, una incidencia, una calificación). Es la forma que esos
 * endpoints devolvían cuando exponían la entidad, con una excepción: **no
 * incluye `deliveryCode`**, el código que el cliente muestra para confirmar la
 * recepción. Ese dato es del cliente y del chofer que entrega, no de un
 * listado.
 *
 * Los endpoints de `/orders` usan otra forma (`OrderResponseDto`); unificarlas
 * cambia el contrato y corresponde a `/v2`.
 */
export class OrderRecordResponseDto {
  @ApiProperty({ format: 'uuid' }) order_id!: string;
  @ApiProperty({ format: 'uuid' }) distributor_id!: string;
  @ApiProperty({ format: 'uuid' }) customer_id!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  delivery_id!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  time_slot_id!: string | null;
  @ApiProperty({ format: 'uuid' }) address_id!: string;
  @ApiProperty({ type: String, nullable: true, example: '2026-09-25' })
  scheduled_date!: string | null;
  @ApiProperty() deposit_amount!: number;
  @ApiProperty() deposit_paid!: boolean;
  @ApiProperty({ enum: OrderStatus }) status!: OrderStatus;
  @ApiProperty({ enum: PaymentMethod }) paymentMethod!: PaymentMethod;
  @ApiProperty({ enum: PaymentType }) paymentType!: PaymentType;
  @ApiProperty({ enum: PaymentStatus }) paymentStatus!: PaymentStatus;
  @ApiProperty() totalAmount!: number;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ type: String, nullable: true })
  deliveryInstructions!: string | null;
  @ApiProperty({ type: String, nullable: true })
  deliveryLatitude!: string | null;
  @ApiProperty({ type: String, nullable: true })
  deliveryLongitude!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  acceptedAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  onTheWayAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  deliveredAt!: Date | null;
  @ApiProperty({ type: String, nullable: true })
  cancellationReason!: string | null;
  @ApiProperty({ type: String, nullable: true })
  gatewayPaymentId!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: Date;
  @ApiPropertyOptional({ type: UserResponseDto })
  customer?: UserResponseDto;
}
