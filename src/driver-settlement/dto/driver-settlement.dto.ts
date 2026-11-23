import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Importe } from '../../common/decorators/importe.decorator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import {
  FechaCalendario,
  FechaCalendarioOpcional,
} from '../../employee/dto/fecha-calendario.decorator';
import {
  DifferenceResolution,
  DriverSettlementStatus,
} from '../domain/driver-settlement.enums';

export class OpenDriverSettlementDto {
  @ApiProperty({ description: 'Chofer (`delivery_id`)' })
  @IsUUID()
  deliveryId!: string;

  @FechaCalendario('2026-11-03')
  businessDate!: string;
}

export class SettlementExpenseDto {
  @ApiProperty({ description: 'Categoría de gasto (de sentido egreso)' })
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ example: 3500, description: 'Mayor que cero' })
  @Importe()
  amount!: number;

  @ApiPropertyOptional({ example: 'Nafta', maxLength: 255 })
  @IsOptional()
  @TextoNoVacio()
  @MaxLength(255)
  description?: string;
}

export class SubmitDriverSettlementDto {
  @ApiProperty({
    example: 42000,
    description: 'Efectivo que el chofer entrega (0 o más)',
  })
  @Importe(0)
  declaredCash!: number;

  @ApiPropertyOptional({
    type: [SettlementExpenseDto],
    description: 'Gastos que pagó con la cobranza',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SettlementExpenseDto)
  expenses?: SettlementExpenseDto[];

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @TextoNoVacio()
  @MaxLength(500)
  notes?: string;
}

export class PreviewExpenseDto {
  @ApiProperty({ example: 3500, description: 'Mayor que cero' })
  @Importe()
  amount!: number;
}

export class PreviewDriverSettlementDto {
  @ApiProperty({
    example: 42000,
    description: 'Efectivo que el chofer piensa entregar (0 o más)',
  })
  @Importe(0)
  declaredCash!: number;

  @ApiPropertyOptional({
    type: [PreviewExpenseDto],
    description: 'Gastos que pagó con la cobranza (sólo el importe)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PreviewExpenseDto)
  expenses?: PreviewExpenseDto[];
}

export class SettlementPreviewDto {
  @ApiProperty({ example: 40000, description: 'Efectivo esperado, en vivo' })
  expectedCash!: number;

  @ApiProperty({ example: 42000 })
  declaredCash!: number;

  @ApiProperty({ example: 3500, description: 'Suma de los gastos' })
  driverExpenses!: number;

  @ApiProperty({
    example: 5500,
    description:
      'Declarado + gastos − esperado: la misma cuenta que se guarda al presentar (negativa: faltante; positiva: sobrante)',
  })
  difference!: number;
}

export class ApproveDriverSettlementDto {
  @ApiProperty({ description: 'Caja donde entra el efectivo rendido' })
  @IsUUID()
  cashBoxId!: string;

  @ApiPropertyOptional({
    enum: DifferenceResolution,
    description:
      'Obligatoria si hay diferencia. `charged_to_driver` (sólo faltantes) se descuenta en la próxima liquidación; `absorbed` lo asume la distribuidora.',
  })
  @IsOptional()
  @IsEnum(DifferenceResolution)
  differenceResolution?: DifferenceResolution;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @TextoNoVacio()
  @MaxLength(500)
  notes?: string;
}

export class QueryDriverSettlementDto extends PaginationDto {
  @FechaCalendarioOpcional('2026-11-03', undefined)
  date?: string;

  @ApiPropertyOptional({ enum: DriverSettlementStatus })
  @IsOptional()
  @IsEnum(DriverSettlementStatus)
  status?: DriverSettlementStatus;

  @ApiPropertyOptional({ description: 'Chofer (`delivery_id`)' })
  @IsOptional()
  @IsUUID()
  deliveryId?: string;
}

export class QueryMySettlementDto {
  @FechaCalendarioOpcional('2026-11-03', undefined)
  date?: string;
}

export class SettlementOrderDto {
  @ApiProperty() orderId!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Ana Gómez',
    description: 'Nombre del cliente que recibió el pedido',
  })
  customerName!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Av. Mitre 1200, piso 3 depto B, Posadas',
    description:
      'Dirección de entrega (sin coordenadas, teléfono ni indicaciones)',
  })
  deliveryAddress!: string | null;
  @ApiProperty({ example: 12000 }) totalAmount!: number;
  @ApiProperty({
    example: 12000,
    description: 'Lo que el chofer cobraba: el total menos la seña ya paga',
  })
  amountToCollect!: number;
  @ApiProperty({ example: 'paid' }) paymentStatus!: string;
  @ApiProperty() deliveredAt!: Date;
}

export class SettlementCollectionDto {
  @ApiProperty() entryId!: string;
  @ApiProperty() accountId!: string;
  @ApiProperty({ example: 'Panadería La Espiga S.R.L.' }) businessName!: string;
  @ApiProperty({ example: 8000 }) amount!: number;
  @ApiProperty() collectedAt!: Date;
}

export class SettlementExpenseResponseDto {
  @ApiProperty() expenseId!: string;
  @ApiProperty() categoryId!: string;
  @ApiProperty({ example: 'Combustible' }) categoryName!: string;
  @ApiProperty({ example: 3500 }) amount!: number;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
}

export class DriverSettlementResponseDto {
  @ApiProperty() settlementId!: string;
  @ApiProperty({ example: 12 }) number!: number;
  @ApiProperty() deliveryId!: string;
  @ApiProperty({ example: 'Juan Pérez' }) driverName!: string;
  @ApiProperty({ example: '2026-11-03' }) businessDate!: string;
  @ApiProperty({ enum: DriverSettlementStatus })
  status!: DriverSettlementStatus;
  @ApiProperty({
    example: 54000,
    description:
      'Pedidos en efectivo + cobros de cuenta corriente en la calle. En una rendición abierta se calcula en vivo.',
  })
  expectedCash!: number;
  @ApiProperty({ type: Number, nullable: true }) declaredCash!: number | null;
  @ApiProperty({ example: 3500 }) driverExpenses!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Declarado + gastos − esperado: negativa es faltante, positiva sobrante',
  })
  difference!: number | null;
  @ApiProperty({ enum: DifferenceResolution, nullable: true })
  differenceResolution!: DifferenceResolution | null;
  @ApiProperty({ type: String, nullable: true }) truckLoadId!: string | null;
  @ApiProperty({ type: String, nullable: true }) destinationCashBoxId!:
    | string
    | null;
  @ApiProperty({ type: String, nullable: true }) cashMovementId!: string | null;
  @ApiProperty({ type: Date, nullable: true }) submittedAt!: Date | null;
  @ApiProperty({ type: Date, nullable: true }) approvedAt!: Date | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty() createdAt!: Date;
}

export class DriverSettlementPageDto {
  @ApiProperty({ type: [DriverSettlementResponseDto] })
  data!: DriverSettlementResponseDto[];
  @ApiProperty({ example: 6 }) total!: number;
}

export class DriverSettlementDetailDto extends DriverSettlementResponseDto {
  @ApiProperty({ example: 48000, description: 'Efectivo de los pedidos' })
  cashFromOrders!: number;
  @ApiProperty({
    example: 6000,
    description: 'Cobros de cuenta corriente en la calle',
  })
  cashFromCollections!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Estado de la carga del camión atada, si la hay',
  })
  truckLoadStatus!: string | null;
  @ApiProperty({ type: [SettlementOrderDto] }) orders!: SettlementOrderDto[];
  @ApiProperty({ type: [SettlementCollectionDto] })
  collections!: SettlementCollectionDto[];
  @ApiProperty({ type: [SettlementExpenseResponseDto] })
  expenses!: SettlementExpenseResponseDto[];
}

export class EfectivoSinRendirDeChoferDto {
  @ApiProperty({ format: 'uuid' }) deliveryId!: string;
  @ApiProperty({ type: String, nullable: true, example: 'Juan Pérez' })
  driverName!: string | null;
  @ApiProperty({
    example: 3,
    description: 'Pedidos en efectivo entregados que ninguna rendición tomó',
  })
  orders!: number;
  @ApiProperty({
    example: 54000,
    description:
      'Lo que cobró el chofer en esos pedidos (total menos la seña ya paga), calculado en el back',
  })
  amount!: number;
  @ApiProperty({ description: 'Entrega del pedido más viejo sin rendir' })
  oldestDeliveredAt!: Date;
  @ApiProperty({
    example: 30,
    description: 'Horas desde esa entrega (redondeadas hacia abajo)',
  })
  ageHours!: number;
  @ApiProperty({
    description:
      'Lleva sin rendir más horas que `minHours`: es lo que dispara el aviso del cierre del día',
  })
  overdue!: boolean;
}

export class EfectivoSinRendirDto {
  @ApiProperty({ type: [EfectivoSinRendirDeChoferDto] })
  items!: EfectivoSinRendirDeChoferDto[];
  @ApiProperty({ example: 108000 }) totalAmount!: number;
  @ApiProperty({ example: 6 }) totalOrders!: number;
  @ApiProperty({
    example: 24,
    description:
      'Antigüedad (horas) configurada para el aviso (`cash_alerts.minHours`)',
  })
  minHours!: number;
  @ApiProperty({
    example: true,
    description:
      'El aviso del cierre del día está encendido (`cash_alerts.enabled`); si es `false` el panel no dice que se avisa',
  })
  enabled!: boolean;
}
