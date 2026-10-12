import {
  ApiProperty,
  ApiPropertyOptional,
  PartialType,
  PickType,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
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
import { MotivoObligatorio } from './motivo.decorator';
import { MAX_COSTO, MAX_RENGLONES, MAX_UNIDADES } from './purchase-limits';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { FechaCalendarioOpcional } from '../../employee/dto/fecha-calendario.decorator';
import { VacioANulo } from '../../employee/dto/vacio-a-nulo.decorator';
import { PurchaseOrderStatus } from '../domain/purchase.enums';
import { PurchaseReceiptSummaryDto } from './purchase-receipt.dto';

export class PurchaseOrderItemInputDto {
  @ApiProperty({ format: 'uuid', description: 'Tipo de garrafa' })
  @IsUUID()
  gasCylinderId!: string;

  @ApiProperty({ example: 40, description: 'Llenas que se piden' })
  @IsInt()
  @Min(1)
  @Max(MAX_UNIDADES)
  quantity!: number;

  @ApiProperty({
    example: 5200.5,
    description: 'Costo por garrafa llena (hasta 2 decimales)',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_COSTO)
  unitCost!: number;

  @ApiPropertyOptional({
    example: 40,
    default: 0,
    description: 'Vacíos que se entregan a la planta a cambio',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_UNIDADES)
  emptiesToExchange?: number;
}

export class CreatePurchaseOrderDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  supplierId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Depósito donde se recibe; si falta, el predeterminado',
  })
  @IsOptional()
  @IsUUID()
  destinationWarehouseId?: string;

  @FechaCalendarioOpcional('2026-10-20', undefined)
  expectedDate?: string | null;

  @ApiPropertyOptional({ example: 'Entrega en horario de la mañana' })
  @VacioANulo()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;

  @ApiProperty({ type: PurchaseOrderItemInputDto, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RENGLONES)
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderItemInputDto)
  items!: PurchaseOrderItemInputDto[];
}

export class UpdatePurchaseOrderDto extends PartialType(
  CreatePurchaseOrderDto,
) {}

export class CancelPurchaseOrderDto {
  @ApiProperty({
    example: 'El proveedor no tiene stock este mes',
    maxLength: 500,
  })
  @MotivoObligatorio()
  reason!: string;
}

export class CloseShortPurchaseOrderDto {
  @ApiProperty({
    example: 'La planta no repone el resto este mes',
    maxLength: 500,
  })
  @MotivoObligatorio()
  reason!: string;
}

export class QueryPurchaseOrderDto extends PickType(PaginationDto, [
  'page',
  'limit',
] as const) {
  @ApiPropertyOptional({ enum: PurchaseOrderStatus })
  @IsOptional()
  @IsEnum(PurchaseOrderStatus)
  status?: PurchaseOrderStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @FechaCalendarioOpcional('2026-10-01', undefined)
  from?: string;

  @FechaCalendarioOpcional('2026-10-31', undefined)
  to?: string;
}

export class PurchaseOrderItemResponseDto {
  @ApiProperty({ format: 'uuid' }) itemId!: string;
  @ApiProperty({ format: 'uuid' }) gasCylinderId!: string;
  @ApiProperty({ example: '10kg' }) gasCylinderType!: string;
  @ApiProperty({ example: 40 }) quantity!: number;
  @ApiProperty({ example: 5200.5 }) unitCost!: number;
  @ApiProperty({ example: 208020 }) subtotal!: number;
  @ApiProperty({ example: 40 }) emptiesToExchange!: number;
  @ApiProperty({ example: 25 }) receivedQuantity!: number;
  @ApiProperty({ example: 15 }) pendingQuantity!: number;
}

export class PurchaseOrderSummaryDto {
  @ApiProperty({ format: 'uuid' }) purchaseOrderId!: string;
  @ApiProperty({ example: 7 }) number!: number;
  @ApiProperty({ format: 'uuid' }) supplierId!: string;
  @ApiProperty({ example: 'Gas del Litoral S.A.' }) supplierName!: string;
  @ApiProperty({ format: 'uuid' }) destinationWarehouseId!: string;
  @ApiProperty({ example: 'Depósito central' })
  destinationWarehouseName!: string;
  @ApiProperty({ enum: PurchaseOrderStatus }) status!: PurchaseOrderStatus;
  @ApiProperty({ nullable: true, type: Date }) issuedAt!: Date | null;
  @ApiProperty({ nullable: true, type: String, example: '2026-10-20' })
  expectedDate!: string | null;
  @ApiProperty({ example: 208020 }) totalAmount!: number;
  @ApiProperty({ nullable: true, type: String }) cancelReason!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Motivo del cierre con faltante (`closed_short`)',
  })
  closeReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) notes!: string | null;
  @ApiProperty({ example: 40 }) orderedQuantity!: number;
  @ApiProperty({ example: 25 }) receivedQuantity!: number;
  @ApiProperty({ example: 15 }) pendingQuantity!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class PurchaseOrderResponseDto extends PurchaseOrderSummaryDto {
  @ApiProperty({ type: PurchaseOrderItemResponseDto, isArray: true })
  items!: PurchaseOrderItemResponseDto[];
  @ApiProperty({
    type: PurchaseReceiptSummaryDto,
    isArray: true,
    description: 'Recepciones de esta orden (las anuladas incluidas)',
  })
  receipts!: PurchaseReceiptSummaryDto[];
}

export class PurchaseOrderPageDto {
  @ApiProperty({ type: PurchaseOrderSummaryDto, isArray: true })
  data!: PurchaseOrderSummaryDto[];
  @ApiProperty({ example: 12 }) total!: number;
}

export class PendingItemDto {
  @ApiProperty({ format: 'uuid' }) gasCylinderId!: string;
  @ApiProperty({ example: '10kg' }) gasCylinderType!: string;
  @ApiProperty({ example: 40 }) ordered!: number;
  @ApiProperty({ example: 25 }) received!: number;
  @ApiProperty({ example: 15 }) pending!: number;
  @ApiProperty({
    example: 40,
    description: 'Vacíos que se canjean por el pedido',
  })
  emptiesToExchange!: number;
}

export class PurchaseOrderPendingDto {
  @ApiProperty({ format: 'uuid' }) purchaseOrderId!: string;
  @ApiProperty({ example: 7 }) number!: number;
  @ApiProperty({ enum: PurchaseOrderStatus }) status!: PurchaseOrderStatus;
  @ApiProperty({ type: PendingItemDto, isArray: true })
  items!: PendingItemDto[];
  @ApiProperty({ example: 15 }) totalPending!: number;
}
