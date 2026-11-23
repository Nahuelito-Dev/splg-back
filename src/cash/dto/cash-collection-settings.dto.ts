import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsUUID, ValidateIf } from 'class-validator';

export class CashCollectionSettingsResponseDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Billetera a la que entran los pagos aprobados de Mercado Pago',
  })
  mercadoPagoCashBoxId!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'Mercado Pago' })
  mercadoPagoCashBoxName!: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Null mientras nunca se configuró',
  })
  updatedAt!: Date | null;
}

export class UpdateCashCollectionSettingsDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Caja de clase billetera (`wallet`) de la distribuidora. `null` la quita: los cobros de Mercado Pago quedan sin asentar. Omitirla la deja como está.',
  })
  @IsOptional()
  @ValidateIf((_, valor) => valor !== null)
  @IsUUID()
  mercadoPagoCashBoxId?: string | null;
}

export class PendingCollectionsQueryDto {
  @ApiPropertyOptional({
    example: '2026-10-01',
    description:
      'Fecha (YYYY-MM-DD, hora argentina) desde la que se cuentan los cobros. Por omisión, los últimos 30 días.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;
}

export class SettlePendingDto {
  @ApiProperty({
    example: '2026-10-01',
    description:
      'Se asientan los cobros confirmados desde esta fecha (YYYY-MM-DD, hora argentina, inclusive; hasta un año atrás). Nada anterior se toca. Si esos cobros ya se cargaron a mano en una caja, asentarlos los duplica.',
  })
  @IsISO8601({ strict: true })
  from!: string;
}

export class PendingCollectionsDetailDto {
  @ApiProperty({ example: 3 }) count!: number;
  @ApiProperty({ example: 45200.5 }) amount!: number;
}

export class PendingCollectionsResponseDto {
  @ApiProperty({ format: 'date-time' }) from!: Date;
  @ApiProperty({ example: 5 }) count!: number;
  @ApiProperty({ example: 78300 }) amount!: number;
  @ApiProperty({ type: PendingCollectionsDetailDto })
  mercadoPago!: PendingCollectionsDetailDto;
  @ApiProperty({
    type: PendingCollectionsDetailDto,
    description:
      'Devoluciones de Mercado Pago ya hechas cuyo egreso de caja falta (el cobro sí entró)',
  })
  refunds!: PendingCollectionsDetailDto;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'El cobro sin asentar más viejo del período',
  })
  oldestAt!: Date | null;
}

export class SettlePendingResponseDto {
  @ApiProperty({
    example: 4,
    description: 'Cobros que entraron a una caja ahora',
  })
  settled!: number;
  @ApiProperty({
    example: 0,
    description: 'Cobros que ya tenían su movimiento',
  })
  alreadySettled!: number;
  @ApiProperty({
    example: 0,
    description: 'Cobros de un medio cuya caja no está configurada',
  })
  withoutCashBox!: number;
  @ApiProperty({
    example: 0,
    description:
      'Cobros que la caja rechazó (desactivada, sin sesión abierta…)',
  })
  failed!: number;
  @ApiProperty({
    example: 0,
    description:
      'Devoluciones (propias o hechas por Mercado Pago) cuyo egreso se asentó ahora',
  })
  refundsSettled!: number;
  @ApiProperty({
    example: 0,
    description:
      'Comisiones de Mercado Pago que se asentaron después de su ingreso',
  })
  feesSettled!: number;
}

export class OrderCollectionEntryDto {
  @ApiProperty({
    enum: ['mercadopago', 'deposit'],
    description:
      '`deposit` es la seña de una reserva recibida a mano. Los pedidos viejos por transferencia no tienen entradas',
  })
  kind!: 'mercadopago' | 'deposit';
  @ApiProperty({ example: 12000 }) amount!: number;
  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  collectedAt!: Date | null;
  @ApiProperty({
    description: 'true si el cobro ya tiene su movimiento de caja',
  })
  settled!: boolean;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  movementId!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  cashBoxId!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'Mercado Pago' })
  cashBoxName!: string | null;
}

export class OrderCashSettlementResponseDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({
    type: [OrderCollectionEntryDto],
    description:
      'Los cobros del pedido por Mercado Pago, la seña recibida a mano y, en pedidos viejos, la transferencia; vacío si no tiene (efectivo, cuenta corriente o todavía sin cobrar)',
  })
  entries!: OrderCollectionEntryDto[];
}
