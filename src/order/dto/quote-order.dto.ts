import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import {
  IntersectionType,
  OmitType,
  PartialType,
  PickType,
} from '@nestjs/swagger';
import { CreateOrderDto } from './create-order.dto';
import { PaymentMethod } from '../entities/order.entity';

const CAMPOS_OBLIGATORIOS = ['items', 'paymentMethod'] as const;

/**
 * Body de `POST /orders/quote`: el mismo que `POST /orders`. Sólo `items` y
 * `paymentMethod` son obligatorios; con `addressId` (y `customerId` si lo
 * pide un admin) se calcula el recargo de la zona de esa dirección.
 */
export class QuoteOrderDto extends IntersectionType(
  PickType(CreateOrderDto, CAMPOS_OBLIGATORIOS),
  PartialType(OmitType(CreateOrderDto, CAMPOS_OBLIGATORIOS)),
) {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Cotización de EDICIÓN de un pedido existente (el del cliente que cotiza, ' +
      'o de la distribuidora del staff; si no, 404). Sólo vale si el pedido es ' +
      'editable (409 con el mismo mensaje que `PATCH /orders/:id`). El stock se ' +
      'compara por la diferencia contra el pedido actual; la franja y la fecha ' +
      'sólo se validan si cambian; lo que no se manda se toma del pedido ' +
      '(dirección y zona incluidas).',
  })
  @IsOptional()
  @IsUUID()
  orderId?: string;
}

export class QuoteItemDto {
  @ApiProperty() gasCylinderId!: string;
  @ApiProperty({ example: 'Garrafa 10kg' }) title!: string;
  @ApiProperty({ example: 2 }) quantity!: number;
  @ApiProperty({
    example: 9500,
    description: 'Precio unitario con la promoción por volumen aplicada',
  })
  unitPrice!: number;
  @ApiProperty({ example: 19000 }) subtotal!: number;
}

export class QuoteZoneDto {
  @ApiProperty() coverageZoneId!: string;
  @ApiProperty({ example: 'Zona norte' }) name!: string;
  @ApiProperty({ enum: ['fixed', 'percentage'] }) type!: string;
  @ApiProperty({ example: 5 }) value!: number;
  @ApiProperty({ example: 950 }) amount!: number;
}

/** Cotización de un pedido: el desglose que después cobra `POST /orders`. */
export class QuoteResponseDto {
  @ApiProperty({ type: [QuoteItemDto] }) items!: QuoteItemDto[];

  @ApiProperty({
    example: 19000,
    description: 'Suma de los renglones, ya con promociones por volumen',
  })
  subtotal!: number;

  @ApiProperty({
    type: QuoteZoneDto,
    nullable: true,
    description:
      'Zona de cobertura de la dirección y su recargo; `null` si no se mandó `addressId` o la distribuidora no tiene zonas',
  })
  zone!: QuoteZoneDto | null;

  @ApiProperty({
    example: 950,
    description: 'Recargo por zona (0 si no hay)',
  })
  zoneSurcharge!: number;

  @ApiProperty({
    enum: PaymentMethod,
    example: PaymentMethod.TRANSFER,
  })
  paymentMethod!: PaymentMethod;

  @ApiProperty({
    example: 1995,
    description:
      'Recargo por medio de pago: +10% sobre subtotal + recargo de zona en `mercadopago` y `transfer`; 0 en `cash`',
  })
  paymentSurcharge!: number;

  @ApiProperty({
    example: 0,
    description: 'Seña de la reserva (0 si no es reserva)',
  })
  deposit!: number;

  @ApiProperty({
    example: 21945,
    description: 'Total del pedido: es el `total` que tendrá el pedido creado',
  })
  total!: number;

  @ApiProperty({
    example: 21945,
    description: 'Saldo a cobrar una vez paga la seña: `total - deposit`',
  })
  balance!: number;
}
