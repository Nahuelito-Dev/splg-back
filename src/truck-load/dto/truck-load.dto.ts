import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import { FechaCalendarioOpcional } from '../../employee/dto/fecha-calendario.decorator';
import {
  PaymentMethod,
  PaymentStatus,
} from '../../order/entities/order.entity';
import { StockMovementDto } from '../../stock/dto/stock-response.dto';
import { TruckLoadStatus } from '../domain/truck-load.enums';

/** Tope de garrafas de un tipo en una carga (un camión no lleva más). */
export const MAX_POR_TIPO = 2000;
export const MAX_RENGLONES = 20;

export class TruckLoadItemInputDto {
  @ApiProperty({ format: 'uuid', description: 'Tipo de garrafa' })
  @IsUUID()
  gasCylinderId!: string;

  @ApiProperty({ example: 40, description: 'Llenas que salen en el camión' })
  @IsInt()
  @Min(0)
  @Max(MAX_POR_TIPO)
  loadedFull!: number;

  @ApiPropertyOptional({
    example: 10,
    default: 0,
    description: 'Vacías con las que sale para canjear',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_POR_TIPO)
  loadedEmpty?: number;
}

export class CreateTruckLoadDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Camión; tiene que estar en uso por el chofer',
  })
  @IsUUID()
  carId!: string;

  @ApiProperty({ format: 'uuid', description: 'Chofer (delivery_id)' })
  @IsUUID()
  deliveryId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Ayudante (legajo del personal)',
  })
  @IsOptional()
  @IsUUID()
  helperEmployeeId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Depósito del que sale la carga y al que vuelve; por defecto el predeterminado',
  })
  @IsOptional()
  @IsUUID()
  originWarehouseId?: string;

  @FechaCalendarioOpcional('2026-10-12', undefined)
  businessDate?: string;

  @ApiProperty({ type: TruckLoadItemInputDto, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RENGLONES)
  @ValidateNested({ each: true })
  @Type(() => TruckLoadItemInputDto)
  items!: TruckLoadItemInputDto[];

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;
}

export class UpdateTruckLoadItemsDto {
  @ApiProperty({
    type: TruckLoadItemInputDto,
    isArray: true,
    description: 'Reemplaza los renglones de la carga (sólo en carga)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RENGLONES)
  @ValidateNested({ each: true })
  @Type(() => TruckLoadItemInputDto)
  items!: TruckLoadItemInputDto[];
}

export class ReloadItemInputDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  gasCylinderId!: string;

  @ApiProperty({ example: 10, description: 'Llenas que se suman al camión' })
  @IsInt()
  @Min(1)
  @Max(MAX_POR_TIPO)
  quantity!: number;
}

export class ReloadTruckLoadDto {
  @ApiProperty({ type: ReloadItemInputDto, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RENGLONES)
  @ValidateNested({ each: true })
  @Type(() => ReloadItemInputDto)
  items!: ReloadItemInputDto[];
}

export class DeclaredItemInputDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  gasCylinderId!: string;

  @ApiProperty({ example: 4, description: 'Llenas que vuelven' })
  @IsInt()
  @Min(0)
  @Max(MAX_POR_TIPO * 2)
  declaredFull!: number;

  @ApiProperty({ example: 36, description: 'Vacías que vuelven' })
  @IsInt()
  @Min(0)
  @Max(MAX_POR_TIPO * 2)
  declaredEmpty!: number;
}

export class ReturnTruckLoadDto {
  @ApiProperty({
    type: DeclaredItemInputDto,
    isArray: true,
    description:
      'Lo que vuelve, de TODAS las garrafas de la carga (aunque vuelvan en cero)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RENGLONES)
  @ValidateNested({ each: true })
  @Type(() => DeclaredItemInputDto)
  items!: DeclaredItemInputDto[];
}

export class CloseTruckLoadDto {
  @ApiPropertyOptional({
    maxLength: 500,
    description:
      'Obligatoria si lo declarado difiere de lo esperado (merma, pérdida o sobrante)',
  })
  @IsOptional()
  @TextoNoVacio()
  @MaxLength(500)
  differenceNote?: string;
}

export class CancelTruckLoadDto {
  @ApiProperty({ maxLength: 300, example: 'El camión no salió' })
  @TextoNoVacio()
  @MaxLength(300)
  reason!: string;
}

export class QueryTruckLoadDto extends PickType(PaginationDto, [
  'page',
  'limit',
] as const) {
  @ApiPropertyOptional({ enum: TruckLoadStatus })
  @IsOptional()
  @IsEnum(TruckLoadStatus)
  status?: TruckLoadStatus;

  @FechaCalendarioOpcional('2026-10-12', undefined)
  date?: string;

  @FechaCalendarioOpcional('2026-10-01', undefined)
  from?: string;

  @FechaCalendarioOpcional('2026-10-31', undefined)
  to?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  carId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Chofer (delivery_id)' })
  @IsOptional()
  @IsUUID()
  deliveryId?: string;
}

export class StockControlSettingsDto {
  @ApiProperty({
    default: false,
    description:
      'Si es true, un chofer sin carga de camión abierta no recibe ofertas ni acepta pedidos',
  })
  @IsBoolean()
  requireOpenTruckLoad!: boolean;
}

export class TruckLoadItemResponseDto {
  @ApiProperty({ format: 'uuid' }) itemId!: string;
  @ApiProperty({ format: 'uuid' }) gasCylinderId!: string;
  @ApiProperty({ example: '10kg' }) gasCylinderType!: string;
  @ApiProperty({ example: 40 }) loadedFull!: number;
  @ApiProperty({ example: 10, description: 'Repuestas en ruta' })
  reloadedFull!: number;
  @ApiProperty({ example: 10 }) loadedEmpty!: number;
  @ApiProperty({
    example: 30,
    description:
      'Llenas entregadas por el camión (en vivo mientras la carga está abierta; congelado al cerrar)',
  })
  deliveredFull!: number;
  @ApiProperty({
    example: 30,
    description: 'Vacías recolectadas (canje 1 a 1)',
  })
  collectedEmpty!: number;
  @ApiProperty({
    example: 20,
    description: 'Cargadas + repuestas - entregadas',
  })
  expectedFull!: number;
  @ApiProperty({ example: 40, description: 'Cargadas + recolectadas' })
  expectedEmpty!: number;
  @ApiProperty({ nullable: true, type: Number })
  declaredReturnFull!: number | null;
  @ApiProperty({ nullable: true, type: Number })
  declaredReturnEmpty!: number | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      'Declarado - esperado; negativo es faltante. null sin declarar',
  })
  differenceFull!: number | null;
  @ApiProperty({ nullable: true, type: Number })
  differenceEmpty!: number | null;
  @ApiProperty({
    example: 20,
    description: 'Llenas que hay hoy en el camión según el libro',
  })
  onTruckFull!: number;
  @ApiProperty({ example: 40 }) onTruckEmpty!: number;
}

export class TruckLoadOrderDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ example: 14500 }) totalAmount!: number;
  @ApiProperty({
    example: 9500,
    description:
      'Saldo que el chofer cobra al entregar: el total menos la seña ya paga',
  })
  remainingBalance!: number;
  @ApiProperty({ enum: PaymentMethod }) paymentMethod!: PaymentMethod;
  @ApiProperty({ enum: PaymentStatus }) paymentStatus!: PaymentStatus;
  @ApiProperty() deliveredAt!: Date;
}

export class TruckLoadCashDto {
  @ApiProperty({ example: 4 }) deliveredOrders!: number;
  @ApiProperty({
    example: 43500,
    description:
      'Efectivo que el chofer confirmó haber cobrado (paid): el saldo de cada pedido, sin la seña que ya se pagó por adelantado',
  })
  cashCollectedAmount!: number;
  @ApiProperty({ example: 3 }) cashCollectedCount!: number;
  @ApiProperty({
    example: 14500,
    description: 'Efectivo que el chofer informó como impago (o dado de baja)',
  })
  unpaidAmount!: number;
  @ApiProperty({ example: 1 }) unpaidCount!: number;
  @ApiProperty({
    example: 0,
    description: 'Efectivo entregado cuyo cobro el chofer todavía no confirmó',
  })
  pendingConfirmationAmount!: number;
  @ApiProperty({ example: 0 }) pendingConfirmationCount!: number;
  @ApiProperty({
    example: 0,
    description:
      'Pedidos cobrados (`paid`) por otro medio (transferencia, Mercado Pago); los pendientes no cuentan',
  })
  nonCashAmount!: number;
}

export class TruckLoadSummaryDto {
  @ApiProperty({ format: 'uuid' }) loadId!: string;
  @ApiProperty({ example: 12, description: 'Número correlativo' })
  number!: number;
  @ApiProperty({ enum: TruckLoadStatus }) status!: TruckLoadStatus;
  @ApiProperty({ example: '2026-10-12' }) businessDate!: string;
  @ApiProperty({ format: 'uuid' }) carId!: string;
  @ApiProperty({ nullable: true, type: String, example: 'AB123CD' })
  carPatent!: string | null;
  @ApiProperty({ format: 'uuid' }) deliveryId!: string;
  @ApiProperty({ example: 'Pedro Gómez' }) driverName!: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  helperEmployeeId!: string | null;
  @ApiProperty({ nullable: true, type: String }) helperName!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  originWarehouseId!: string | null;
  @ApiProperty({ example: 'Depósito central' }) originName!: string;
  @ApiProperty() openedAt!: Date;
  @ApiProperty({ nullable: true, type: Date }) departedAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) returnedAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) closedAt!: Date | null;
  @ApiProperty({
    example: 2,
    description: 'Renglones (tipos de garrafa) de la carga',
  })
  itemsCount!: number;
}

export class TruckLoadResponseDto extends TruckLoadSummaryDto {
  @ApiProperty({ type: TruckLoadItemResponseDto, isArray: true })
  items!: TruckLoadItemResponseDto[];
  @ApiProperty({
    nullable: true,
    type: Boolean,
    description:
      'Vista previa del cierre (mismo cálculo que `close`): true si la rendición tendría diferencias (declarado distinto del esperado, o el camión con otra cosa que lo declarado). null mientras no se declaró la vuelta de todos los renglones y en cargas cerradas o canceladas (ahí vale el estado).',
  })
  hayDiferencia!: boolean | null;
  @ApiProperty({
    example: false,
    description:
      'true si el camión entregó garrafas DESPUÉS de declarar la vuelta: el cierre respondería 409 hasta que el chofer vuelva a declarar. En ese caso `hayDiferencia` es null.',
  })
  requiereVolverADeclarar!: boolean;
  @ApiProperty({ nullable: true, type: String }) differenceNote!: string | null;
  @ApiProperty({ nullable: true, type: String }) cancelReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) notes!: string | null;
  @ApiProperty({ format: 'uuid' }) openedByUserId!: string;
  @ApiProperty({
    type: TruckLoadOrderDto,
    isArray: true,
    description:
      'Pedidos que el chofer entregó con este camión durante la carga',
  })
  orders!: TruckLoadOrderDto[];
  @ApiProperty({
    type: TruckLoadCashDto,
    description:
      'Informativo: el efectivo de la jornada (la caja todavía no existe)',
  })
  cash!: TruckLoadCashDto;
  @ApiProperty({
    type: StockMovementDto,
    isArray: true,
    description:
      'Movimientos del libro de esta carga (salida, reposiciones, vuelta y ajustes); las entregas se ven por pedido',
  })
  movements!: StockMovementDto[];
  @ApiProperty() createdAt!: Date;
}

export class TruckLoadPageDto {
  @ApiProperty({ type: TruckLoadSummaryDto, isArray: true })
  data!: TruckLoadSummaryDto[];
  @ApiProperty({ example: 12 }) total!: number;
}

export class MyTruckLoadDto {
  @ApiProperty({
    type: TruckLoadResponseDto,
    nullable: true,
    description: 'La carga abierta del chofer; null si no tiene',
  })
  load!: TruckLoadResponseDto | null;
  @ApiProperty({
    description:
      'Si la distribuidora exige carga abierta para recibir y aceptar pedidos',
  })
  requireOpenTruckLoad!: boolean;
}

export class TruckStockItemDto {
  @ApiProperty({ format: 'uuid' }) gasCylinderId!: string;
  @ApiProperty({ example: '10kg' }) gasCylinderType!: string;
  @ApiProperty({ example: 20 }) full!: number;
  @ApiProperty({ example: 40 }) empty!: number;
  @ApiProperty({ example: 0 }) defective!: number;
}

export class TruckStockDto {
  @ApiProperty({ format: 'uuid' }) carId!: string;
  @ApiProperty({ nullable: true, type: String }) carPatent!: string | null;
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'Carga abierta del camión, si tiene',
  })
  openLoadId!: string | null;
  @ApiProperty({ type: TruckStockItemDto, isArray: true })
  items!: TruckStockItemDto[];
}
