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
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrderDeliveryMode, PaymentMethod } from '../entities/order.entity';
import { SetOrderReceiverDto } from './set-order-receiver.dto';

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

  @ApiProperty({
    description:
      'Ítems del pedido. Obligatorio salvo con `fromCart: true`, que los toma del carrito (con ambos, 400)',
    type: [OrderItemDto],
    required: false,
  })
  @ValidateIf(
    (o: CreateOrderDto) => o.fromCart !== true || o.items !== undefined,
  )
  @IsArray()
  @ArrayUnique((item: OrderItemDto) => item.gasCylinderId, {
    message:
      'items no puede repetir la misma garrafa: sumá las cantidades en un solo renglón',
  })
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items?: OrderItemDto[];

  @ApiProperty({
    description:
      'Checkout del carrito (CU-126): los ítems salen del carrito del cliente en la distribuidora del header `X-Distributor`, se cobra el precio vigente del catálogo y el carrito se vacía en la misma transacción que el pedido. Sin `items` en el cuerpo. Sólo el cliente; carrito vacío o con productos dados de baja es 400.',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  fromCart?: boolean;

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
      'Monto de la seña de la reserva (obligatorio si isReservation). No puede superar el total del pedido (con recargos): 400 «La seña ($X) no puede superar el total del pedido ($Y)».',
    required: false,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  depositAmount?: number;

  @ApiPropertyOptional({
    type: SetOrderReceiverDto,
    description:
      'Quién va a recibir el pedido (CU-128): mismas reglas que `PATCH /orders/:id/receiver`.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => SetOrderReceiverDto)
  receiver?: SetOrderReceiverDto;

  @ApiProperty({
    description:
      'Modalidad de entrega (CU-148). `standard` (por omisión) es el reparto común; ' +
      '`express` sale a un chofer en moto con el recargo express de la distribuidora. ' +
      'Se vuelve a evaluar al crear el pedido: si no hay cobertura, horario o una moto ' +
      'disponible responde 409 con `reason`. No se combina con reserva, franja ni fecha agendada.',
    enum: OrderDeliveryMode,
    required: false,
    example: OrderDeliveryMode.STANDARD,
  })
  @IsOptional()
  @IsEnum(OrderDeliveryMode, {
    message: `deliveryMode debe ser uno de: ${Object.values(OrderDeliveryMode).join(', ')}`,
  })
  deliveryMode?: OrderDeliveryMode;
}
