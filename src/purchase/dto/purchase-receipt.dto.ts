import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import { MotivoObligatorio } from './motivo.decorator';
import { MAX_COSTO, MAX_RENGLONES, MAX_UNIDADES } from './purchase-limits';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { FechaCalendarioOpcional } from '../../employee/dto/fecha-calendario.decorator';
import { VacioANulo } from '../../employee/dto/vacio-a-nulo.decorator';
import {
  PaymentStatus,
  PurchaseReceiptStatus,
  SupplierDocumentType,
} from '../domain/purchase.enums';

export class PurchaseReceiptItemInputDto {
  @ApiProperty({ format: 'uuid', description: 'Tipo de garrafa' })
  @IsUUID()
  gasCylinderId!: string;

  @ApiProperty({ example: 25, description: 'Llenas que llegaron' })
  @IsInt()
  @Min(0)
  @Max(MAX_UNIDADES)
  quantityFull!: number;

  @ApiPropertyOptional({
    example: 25,
    default: 0,
    description:
      'Vacías que se llevó la planta; salen del depósito y no pueden dejarlo en negativo',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_UNIDADES)
  quantityEmptyOut?: number;

  @ApiPropertyOptional({
    example: 5200.5,
    description:
      'Costo por llena del remito. Con orden de compra, si falta se usa el de la orden; sin orden es obligatorio.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_COSTO)
  unitCost?: number;
}

export class CreatePurchaseReceiptDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Orden de compra que se recibe; sin ella es una compra directa',
  })
  @IsOptional()
  @IsUUID()
  purchaseOrderId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Obligatorio sin orden; con orden tiene que ser el de la orden',
  })
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Depósito destino. Con orden: el de la orden (si se indica otro, 400); sin orden: el indicado o el predeterminado',
  })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiProperty({
    enum: SupplierDocumentType,
    example: SupplierDocumentType.DELIVERY_NOTE,
  })
  @IsEnum(SupplierDocumentType)
  supplierDocumentType!: SupplierDocumentType;

  @ApiProperty({
    example: '0001-00004567',
    description:
      'Número del remito o la factura del proveedor; único por proveedor',
    maxLength: 30,
  })
  @TextoNoVacio()
  @MaxLength(30)
  supplierDocumentNumber!: string;

  @ApiPropertyOptional({
    example: '2026-10-12T14:30:00-03:00',
    description: 'Cuándo llegó (default: ahora). No puede ser futuro.',
  })
  @IsOptional()
  @IsISO8601()
  receivedAt?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 500,
    example: 'Llegó en el camión de las 14',
  })
  @VacioANulo()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;

  @ApiProperty({ type: PurchaseReceiptItemInputDto, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RENGLONES)
  @ValidateNested({ each: true })
  @Type(() => PurchaseReceiptItemInputDto)
  items!: PurchaseReceiptItemInputDto[];
}

export class VoidPurchaseReceiptDto {
  @ApiProperty({ example: 'Remito cargado dos veces', maxLength: 500 })
  @MotivoObligatorio()
  reason!: string;
}

export class UpdatePaymentStatusDto {
  @ApiProperty({ enum: PaymentStatus, example: PaymentStatus.PAID })
  @IsEnum(PaymentStatus)
  paymentStatus!: PaymentStatus;

  @ApiPropertyOptional({
    description:
      'Con `paymentStatus: paid`: se pagó en efectivo de una caja de la distribuidora (por omisión, no). Con cajas de efectivo activas exige `cashBoxId`',
  })
  @IsOptional()
  @IsBoolean()
  paidInCash?: boolean;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Caja de efectivo de la que sale el pago; sólo con `paidInCash`',
  })
  @IsOptional()
  @IsUUID()
  cashBoxId?: string;
}

export class QueryPurchaseReceiptDto extends PickType(PaginationDto, [
  'page',
  'limit',
] as const) {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  purchaseOrderId?: string;

  @ApiPropertyOptional({ enum: PaymentStatus })
  @IsOptional()
  @IsEnum(PaymentStatus)
  paymentStatus?: PaymentStatus;

  @ApiPropertyOptional({ enum: PurchaseReceiptStatus })
  @IsOptional()
  @IsEnum(PurchaseReceiptStatus)
  status?: PurchaseReceiptStatus;

  @FechaCalendarioOpcional('2026-10-01', undefined)
  from?: string;

  @FechaCalendarioOpcional('2026-10-31', undefined)
  to?: string;
}

export class QuerySupplierHistoryDto extends PickType(PaginationDto, [
  'page',
  'limit',
] as const) {
  @FechaCalendarioOpcional('2026-10-01', undefined)
  from?: string;

  @FechaCalendarioOpcional('2026-10-31', undefined)
  to?: string;
}

export class PurchaseReceiptItemResponseDto {
  @ApiProperty({ format: 'uuid' }) itemId!: string;
  @ApiProperty({ format: 'uuid' }) gasCylinderId!: string;
  @ApiProperty({ example: '10kg' }) gasCylinderType!: string;
  @ApiProperty({ example: 25 }) quantityFull!: number;
  @ApiProperty({ example: 25 }) quantityEmptyOut!: number;
  @ApiProperty({ example: 5200.5 }) unitCost!: number;
  @ApiProperty({ example: 130012.5 }) subtotal!: number;
}

export class PurchaseReceiptSummaryDto {
  @ApiProperty({ format: 'uuid' }) receiptId!: string;
  @ApiProperty({ example: 3, description: 'Número interno correlativo' })
  number!: number;
  @ApiProperty({ format: 'uuid' }) supplierId!: string;
  @ApiProperty({ example: 'Gas del Litoral S.A.' }) supplierName!: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  purchaseOrderId!: string | null;
  @ApiProperty({ nullable: true, type: Number, example: 7 })
  purchaseOrderNumber!: number | null;
  @ApiProperty({ format: 'uuid' }) warehouseId!: string;
  @ApiProperty({ example: 'Depósito central' }) warehouseName!: string;
  @ApiProperty({ enum: SupplierDocumentType })
  supplierDocumentType!: SupplierDocumentType;
  @ApiProperty({ example: '0001-00004567' }) supplierDocumentNumber!: string;
  @ApiProperty() receivedAt!: Date;
  @ApiProperty({ example: 130012.5 }) totalAmount!: number;
  @ApiProperty({ enum: PaymentStatus }) paymentStatus!: PaymentStatus;
  @ApiProperty({ enum: PurchaseReceiptStatus }) status!: PurchaseReceiptStatus;
}

export class PurchaseReceiptResponseDto extends PurchaseReceiptSummaryDto {
  @ApiProperty({ type: PurchaseReceiptItemResponseDto, isArray: true })
  items!: PurchaseReceiptItemResponseDto[];
  @ApiProperty({ nullable: true, type: String }) notes!: string | null;
  @ApiProperty({ nullable: true, type: String }) voidReason!: string | null;
  @ApiProperty({ nullable: true, type: Date }) voidedAt!: Date | null;
  @ApiProperty({ format: 'uuid' }) receivedByUserId!: string;
  @ApiProperty({
    format: 'uuid',
    description:
      'Lote del libro de movimientos (GET /stock/movements?batchId=)',
  })
  batchId!: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  voidBatchId!: string | null;
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description:
      'Salida de caja del pago en efectivo; `null` si no se pagó en efectivo. Al marcar la recepción como impaga se asienta el contraasiento y vuelve a `null`',
  })
  cashMovementId!: string | null;
  @ApiProperty() createdAt!: Date;
}

/** La recepción con su estado de pago (API v2). */
export class PurchaseReceiptV2SummaryDto extends PurchaseReceiptSummaryDto {
  @ApiProperty({ description: 'Si la recepción figura como pagada' })
  isPaid!: boolean;
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'Salida de caja del pago; `null` si no salió de una caja',
  })
  cashMovementId!: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Cuándo se pagó; `null` si está impaga o figura pagada desde antes de registrar la fecha',
  })
  paidAt!: Date | null;
}

export class PurchaseReceiptV2ResponseDto extends PurchaseReceiptResponseDto {
  @ApiProperty({ description: 'Si la recepción figura como pagada' })
  isPaid!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  paidAt!: Date | null;
}

export class PurchaseReceiptV2PageDto {
  @ApiProperty({ type: PurchaseReceiptV2SummaryDto, isArray: true })
  data!: PurchaseReceiptV2SummaryDto[];
  @ApiProperty({ example: 12 }) total!: number;
}

export class PurchaseReceiptPageDto {
  @ApiProperty({ type: PurchaseReceiptSummaryDto, isArray: true })
  data!: PurchaseReceiptSummaryDto[];
  @ApiProperty({ example: 12 }) total!: number;
}

export class SupplierHistoryDto {
  @ApiProperty({ format: 'uuid' }) supplierId!: string;
  @ApiProperty({ example: 'Gas del Litoral S.A.' }) supplierName!: string;
  @ApiProperty({
    example: 4,
    description: 'Recepciones confirmadas del período',
  })
  receiptsCount!: number;
  @ApiProperty({
    example: 520050,
    description: 'Σ de las recepciones confirmadas del período',
  })
  totalAmount!: number;
  @ApiProperty({
    example: 100,
    description: 'Llenas recibidas (confirmadas) del período',
  })
  fullReceived!: number;
  @ApiProperty({ type: PurchaseReceiptSummaryDto, isArray: true })
  data!: PurchaseReceiptSummaryDto[];
  @ApiProperty({
    example: 5,
    description: 'Total de recepciones (con las anuladas) para paginar',
  })
  total!: number;
}

export class AverageCostDto {
  @ApiProperty({ format: 'uuid' }) gasCylinderId!: string;
  @ApiProperty({ example: '10kg' }) gasCylinderType!: string;
  @ApiProperty({
    nullable: true,
    type: Number,
    example: 5180.25,
    description: 'Costo promedio ponderado; null si nunca se compró',
  })
  averageUnitCost!: number | null;
  @ApiProperty({ nullable: true, type: Number, example: 5200.5 })
  lastUnitCost!: number | null;
  @ApiProperty({ nullable: true, type: Date }) lastReceivedAt!: Date | null;
  @ApiProperty({ example: 85, description: 'Llenas en depósitos y camiones' })
  fullOnHand!: number;
}
