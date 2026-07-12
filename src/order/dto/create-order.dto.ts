// order/dto/create-order.dto.ts
import {
  IsUUID,
  IsString,
  IsNumber,
  IsOptional,
  IsEnum,
  IsArray,
  IsDateString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { PaymentMethod } from '../entities/order.entity';

export class OrderItemDto {
  @ApiProperty({ description: 'ID de la garrafa' })
  @IsUUID()
  gasCylinderId: string;

  @ApiProperty({ description: 'Cantidad' })
  @IsNumber()
  quantity: number;

  @ApiProperty({ description: 'Precio unitario' })
  @IsNumber()
  unitPrice: number;
}

export class CreateOrderDto {
  @ApiProperty({ description: 'ID del cliente' })
  @IsUUID()
  customerId: string;

  @ApiProperty({ description: 'ID de la dirección de entrega' })
  @IsUUID()
  addressId: string;

  @ApiProperty({ description: 'Ítems del pedido', type: [OrderItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  @ApiProperty({
    description: 'Método de pago',
    enum: PaymentMethod,
    example: PaymentMethod.CASH,
  })
  @IsEnum(PaymentMethod, {
    message: `paymentMethod debe ser uno de: ${Object.values(PaymentMethod).join(', ')}`,
  })
  paymentMethod: PaymentMethod;

  @ApiProperty({ description: 'Notas adicionales', required: false })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiProperty({ description: 'Token de notificación push', required: false })
  @IsOptional()
  @IsString()
  notificationToken?: string;

  @ApiProperty({ description: 'ID del turno de entrega (TimeSlot)', required: false })
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
}
