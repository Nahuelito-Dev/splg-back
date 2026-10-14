// order/dto/create-order.dto.ts
import {
  IsUUID,
  IsString,
  IsInt,
  IsNumber,
  IsOptional,
  IsEnum,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { PaymentMethod } from '../entities/order.entity';

export class OrderItemDto {
  @ApiProperty({ description: 'ID de la garrafa' })
  @IsUUID()
  gasCylinderId!: string;

  @ApiProperty({ description: 'Cantidad (entero, mínimo 1)', minimum: 1 })
  @IsInt()
  @Min(1)
  quantity!: number;

  @ApiProperty({ description: 'Precio unitario' })
  @IsNumber()
  unitPrice!: number;
}

export class CreateOrderDto {
  @ApiProperty({ description: 'ID del cliente' })
  @IsUUID()
  customerId!: string;

  @ApiProperty({ description: 'ID de la dirección de entrega' })
  @IsUUID()
  addressId!: string;

  @ApiProperty({ description: 'Ítems del pedido', type: [OrderItemDto] })
  @IsArray()
  @ArrayUnique((item: OrderItemDto) => item.gasCylinderId, {
    message:
      'items no puede repetir la misma garrafa: sumá las cantidades en un solo renglón',
  })
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];

  @ApiProperty({
    description: 'Método de pago',
    enum: PaymentMethod,
    example: PaymentMethod.CASH,
  })
  @IsEnum(PaymentMethod, {
    message: `paymentMethod debe ser uno de: ${Object.values(PaymentMethod).join(', ')}`,
  })
  paymentMethod!: PaymentMethod;

  @ApiProperty({ description: 'Notas adicionales', required: false })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiProperty({ description: 'Token de notificación push', required: false })
  @IsOptional()
  @IsString()
  notificationToken?: string;

  @ApiProperty({
    description: 'ID del turno de entrega (TimeSlot)',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  timeSlotId?: string;

  @ApiProperty({
    description:
      'Fecha agendada de entrega (YYYY-MM-DD). Con timeSlotId, agenda el pedido ' +
      'a esa franja de ese día (valida capacidad). Omitir = entrega inmediata.',
    required: false,
    example: '2026-07-15',
  })
  @IsOptional()
  @IsDateString()
  scheduledDate?: string;

  @ApiProperty({
    description:
      'Marca el pedido como pre-reserva: reserva stock para la fecha agendada ' +
      'pero NO se despacha hasta que la seña esté paga y llegue el día (el ' +
      'sistema lo activa solo). Requiere scheduledDate.',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  isReservation?: boolean;

  @ApiProperty({
    description:
      'Monto de la seña de la reserva (obligatorio si isReservation).',
    required: false,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  depositAmount?: number;
}
