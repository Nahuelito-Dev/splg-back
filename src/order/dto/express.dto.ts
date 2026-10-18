import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { OrderDeliveryMode, PaymentMethod } from '../entities/order.entity';
import { QuoteResponseDto } from './quote-order.dto';

/** Query de `GET /orders/delivery-options` (CU-148). */
export class DeliveryOptionsQueryDto {
  @ApiProperty({ format: 'uuid', description: 'Dirección de entrega elegida' })
  @IsUUID()
  addressId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Dueño de la dirección: sólo lo manda el administrador',
  })
  @IsOptional()
  @IsUUID()
  customerId?: string;
}

export class DeliveryOptionDto {
  @ApiProperty({ enum: OrderDeliveryMode })
  mode!: OrderDeliveryMode;

  @ApiProperty({ example: true })
  available!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: [
      'disabled',
      'no_location',
      'out_of_coverage',
      'out_of_hours',
      'no_motorcycle_driver',
    ],
    description: 'Por qué no está disponible (null si lo está)',
  })
  reason!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Explicación para mostrarle al cliente',
  })
  message!: string | null;

  @ApiProperty({
    example: 1500,
    description:
      'Recargo de la modalidad (0 en `standard`); se suma al final del total',
  })
  surchargeAmount!: number;

  @ApiProperty({ example: 45, description: 'Tiempo estimado, en minutos' })
  estimatedMinutes!: number;
}

export class DeliveryOptionsResponseDto {
  @ApiProperty({ format: 'uuid' })
  addressId!: string;

  @ApiProperty({
    type: [DeliveryOptionDto],
    description:
      'La modalidad `standard` siempre figura; `express` sólo está disponible con cobertura, horario y una moto cerca. Consultar no escribe nada: el alta vuelve a evaluar.',
  })
  options!: DeliveryOptionDto[];
}

/** Cuerpo de `POST /orders/express` y `POST /orders/express/quote` (CU-147). */
export class ExpressPurchaseDto {
  @ApiProperty({ enum: PaymentMethod, example: PaymentMethod.CASH })
  @IsEnum(PaymentMethod, {
    message: `paymentMethod debe ser uno de: ${Object.values(PaymentMethod).join(', ')}`,
  })
  paymentMethod!: PaymentMethod;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Tipo de garrafa. Si no se manda, el de la última compra del cliente en esta distribuidora; sin compras previas es obligatorio (400).',
  })
  @IsOptional()
  @IsUUID()
  gasCylinderId?: string;

  @ApiPropertyOptional({
    default: 1,
    minimum: 1,
    maximum: 10,
    description: 'Cantidad de garrafas (una por omisión)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  quantity?: number;

  @ApiPropertyOptional({ description: 'Token de notificación push' })
  @IsOptional()
  @IsString()
  notificationToken?: string;
}

export class ExpressAddressDto {
  @ApiProperty({ format: 'uuid' })
  addressId!: string;

  @ApiProperty({ example: 'Av. Siempre Viva 742' })
  street!: string;

  @ApiProperty({ example: 'Posadas' })
  city!: string;
}

export class ExpressItemDto {
  @ApiProperty({ format: 'uuid' })
  gasCylinderId!: string;

  @ApiProperty({ example: 1 })
  quantity!: number;
}

/** Vista previa de la compra express: lo que el cliente confirma (CU-147 pasos 2 a 5). */
export class ExpressPreviewResponseDto {
  @ApiProperty({
    example: true,
    description:
      'false: no hay cobertura, horario o moto; la app ofrece el flujo con franja horaria (`fallback: "scheduled"`)',
  })
  available!: boolean;

  @ApiProperty({ type: String, nullable: true })
  reason!: string | null;

  @ApiProperty({ type: String, nullable: true })
  message!: string | null;

  @ApiProperty({ type: String, nullable: true, enum: ['scheduled'] })
  fallback!: 'scheduled' | null;

  @ApiProperty({
    type: ExpressAddressDto,
    description: 'Dirección predeterminada',
  })
  address!: ExpressAddressDto;

  @ApiProperty({ type: ExpressItemDto, description: 'Lo que se compra' })
  item!: ExpressItemDto;

  @ApiProperty({
    type: QuoteResponseDto,
    nullable: true,
    description:
      'Precio final con el recargo express (null si no está disponible)',
  })
  quote!: QuoteResponseDto | null;

  @ApiProperty({ type: Number, nullable: true, example: 45 })
  estimatedMinutes!: number | null;
}
