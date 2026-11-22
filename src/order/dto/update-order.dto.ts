import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaymentMethod } from '../entities/order.entity';
import { RechazarTransferenciaEnDto } from '../domain/medio-de-pago-aceptado';

/** Renglón de la edición: el precio lo pone el servidor, nunca el cliente. */
export class UpdateOrderItemDto {
  @ApiProperty({ format: 'uuid', description: 'ID de la garrafa (producto)' })
  @IsUUID()
  gasCylinderId!: string;

  @ApiProperty({ example: 2, minimum: 1 })
  @IsInt()
  @Min(1)
  quantity!: number;
}

/**
 * Edición de un pedido pendiente (sin chofer). Todos los campos son
 * opcionales; `items`, si viene, reemplaza TODOS los renglones.
 */
export class UpdateOrderDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Otra dirección del mismo cliente',
  })
  @IsOptional()
  @IsUUID()
  addressId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    type: String,
    nullable: true,
    description:
      'Franja de entrega. `null` saca la franja. Si la fecha agendada ya ' +
      'pasó, hay que mandar también `scheduledDate`.',
  })
  @IsOptional()
  @IsUUID()
  timeSlotId?: string | null;

  @ApiPropertyOptional({
    example: '2026-10-15',
    description: 'Fecha agendada (YYYY-MM-DD); con franja valida el cupo',
  })
  @IsOptional()
  @IsDateString()
  scheduledDate?: string;

  @ApiPropertyOptional({
    enum: Object.values(PaymentMethod).filter(
      (m) => m !== PaymentMethod.TRANSFER,
    ),
    description:
      'Medio de pago. No se puede pasar a ni desde MercadoPago: ' +
      'cancelá y creá el pedido de nuevo.',
  })
  @IsOptional()
  @RechazarTransferenciaEnDto()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  @ApiPropertyOptional({ example: 'Tocar timbre 2B' })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({
    type: [UpdateOrderItemDto],
    description:
      'Renglones nuevos: reemplazan a los actuales (se devuelve el stock ' +
      'viejo y se reserva el nuevo, con los precios vigentes)',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique((item: UpdateOrderItemDto) => item.gasCylinderId, {
    message:
      'items no puede repetir la misma garrafa (sumá las cantidades en un solo renglón)',
  })
  @ValidateNested({ each: true })
  @Type(() => UpdateOrderItemDto)
  items?: UpdateOrderItemDto[];
}
