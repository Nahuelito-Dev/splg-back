import { ApiProperty } from '@nestjs/swagger';
import {
  StockAdjustmentReason,
  StockCondition,
  StockLocationKind,
  StockMovementReason,
  StockReferenceType,
} from '../domain/stock.enums';

export class StockLocationRefDto {
  @ApiProperty({ format: 'uuid' }) locationId!: string;
  @ApiProperty({ example: 'Depósito central' }) name!: string;
  @ApiProperty({ enum: StockLocationKind }) kind!: StockLocationKind;
}

export class StockLocationDto extends StockLocationRefDto {
  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  warehouseId!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  carId!: string | null;
}

export class StockBalanceDto {
  @ApiProperty({ format: 'uuid' }) locationId!: string;
  @ApiProperty() locationName!: string;
  @ApiProperty({ enum: StockLocationKind }) locationKind!: StockLocationKind;
  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  warehouseId!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  carId!: string | null;
  @ApiProperty({ format: 'uuid' }) gasCylinderId!: string;
  @ApiProperty({ example: '10kg' }) gasCylinderType!: string;
  @ApiProperty({ enum: StockCondition }) condition!: StockCondition;
  @ApiProperty({ example: 40 }) quantity!: number;
  @ApiProperty() updatedAt!: Date;
}

export class ConditionTotalsDto {
  @ApiProperty() full!: number;
  @ApiProperty() empty!: number;
  @ApiProperty() defective!: number;
}

export class StockSummaryDto {
  @ApiProperty({ format: 'uuid' }) gasCylinderId!: string;
  @ApiProperty({ example: '10kg' }) gasCylinderType!: string;
  @ApiProperty({ type: ConditionTotalsDto, description: 'En los depósitos' })
  warehouses!: ConditionTotalsDto;
  @ApiProperty({ type: ConditionTotalsDto, description: 'En los camiones' })
  vehicles!: ConditionTotalsDto;
  @ApiProperty({ description: 'Llenas en depósitos y camiones' })
  physicalFull!: number;
  @ApiProperty({ description: 'Unidades de pedidos abiertos' })
  reserved!: number;
  @ApiProperty({ description: '`gas_cylinder.stock`: lo que se puede vender' })
  sellable!: number;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Suma de los mínimos de llenas configurados; null si no hay',
  })
  minimumFull!: number | null;
}

export class StockMovementDto {
  @ApiProperty({ format: 'uuid' }) movementId!: string;
  @ApiProperty({ format: 'uuid' }) batchId!: string;
  @ApiProperty() occurredAt!: Date;
  @ApiProperty({ format: 'uuid' }) gasCylinderId!: string;
  @ApiProperty({ example: '10kg' }) gasCylinderType!: string;
  @ApiProperty({ example: 5 }) quantity!: number;
  @ApiProperty({ type: StockLocationRefDto, nullable: true })
  from!: StockLocationRefDto | null;
  @ApiProperty({ enum: StockCondition, nullable: true })
  fromCondition!: StockCondition | null;
  @ApiProperty({ type: StockLocationRefDto, nullable: true })
  to!: StockLocationRefDto | null;
  @ApiProperty({ enum: StockCondition, nullable: true })
  toCondition!: StockCondition | null;
  @ApiProperty({ enum: StockMovementReason }) reason!: StockMovementReason;
  @ApiProperty({ enum: StockReferenceType }) referenceType!: StockReferenceType;
  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  referenceId!: string | null;
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'Si es un contraasiento, el movimiento que anula',
  })
  reversedMovementId!: string | null;
  @ApiProperty({ nullable: true, type: String }) notes!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Quién lo hizo; null si lo hizo el sistema',
  })
  actorName!: string | null;
}

export class StockMovementPageDto {
  @ApiProperty({ type: StockMovementDto, isArray: true })
  data!: StockMovementDto[];
  @ApiProperty({ example: 120 }) total!: number;
}

export class StockOperationResultDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Identifica el lote de movimientos de la operación',
  })
  batchId!: string;
  @ApiProperty({ type: StockMovementDto, isArray: true })
  movements!: StockMovementDto[];
}

export class StockAdjustmentItemResponseDto {
  @ApiProperty({ format: 'uuid' }) gasCylinderId!: string;
  @ApiProperty({ example: '10kg' }) gasCylinderType!: string;
  @ApiProperty({ enum: StockCondition }) condition!: StockCondition;
  @ApiProperty({ example: -2 }) quantityDelta!: number;
}

export class StockAdjustmentResponseDto {
  @ApiProperty({ format: 'uuid' }) adjustmentId!: string;
  @ApiProperty({ example: 7, description: 'Correlativo por distribuidora' })
  number!: number;
  @ApiProperty({ type: StockLocationRefDto }) location!: StockLocationRefDto;
  @ApiProperty({ enum: StockAdjustmentReason }) reason!: StockAdjustmentReason;
  @ApiProperty() notes!: string;
  @ApiProperty({ format: 'uuid' }) batchId!: string;
  @ApiProperty({ nullable: true, type: String }) createdByName!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ type: StockAdjustmentItemResponseDto, isArray: true })
  items!: StockAdjustmentItemResponseDto[];
}

export class StockAdjustmentPageDto {
  @ApiProperty({ type: StockAdjustmentResponseDto, isArray: true })
  data!: StockAdjustmentResponseDto[];
  @ApiProperty({ example: 12 }) total!: number;
}

export class StockThresholdDto {
  @ApiProperty({ format: 'uuid' }) thresholdId!: string;
  @ApiProperty({ format: 'uuid' }) warehouseId!: string;
  @ApiProperty() warehouseName!: string;
  @ApiProperty({ format: 'uuid' }) gasCylinderId!: string;
  @ApiProperty({ example: '10kg' }) gasCylinderType!: string;
  @ApiProperty({ example: 20 }) minFull!: number;
  @ApiProperty({
    example: 35,
    description: 'Llenas que hay hoy en el depósito',
  })
  currentFull!: number;
  @ApiProperty({
    nullable: true,
    type: Date,
    description: 'Cuándo se avisó; null si no hay aviso vigente',
  })
  alertedAt!: Date | null;
}

export class DiferenciaDeVendibleDto {
  @ApiProperty({ format: 'uuid' }) gasCylinderId!: string;
  @ApiProperty({ example: '10kg' }) gasCylinderType!: string;
  @ApiProperty({ description: '`gas_cylinder.stock`' }) sellable!: number;
  @ApiProperty({ description: 'Llenas en depósitos y camiones' })
  physicalFull!: number;
  @ApiProperty({ description: 'Unidades de pedidos abiertos' })
  reserved!: number;
  @ApiProperty({
    description:
      'Lo que debería valer el vendible: max(0, llenas - reservadas)',
  })
  expected!: number;
  @ApiProperty({
    description:
      'Reservas de pedidos abiertos que el físico no cubre (max(0, reservadas - llenas)). Mientras sea mayor que cero el vendible queda en 0: cancelar pedidos o reponer stock lo cubre primero y sólo el resto vuelve a ser vendible',
  })
  overReserved!: number;
  @ApiProperty({
    description: 'sellable - expected; distinto de cero es una discrepancia',
  })
  difference!: number;
  @ApiProperty({
    description:
      'Déficit de reservas guardado (`gas_cylinder.reservation_deficit`): lo que el vendible en cero ocultó cuando una pérdida dejó las reservas por encima del físico',
  })
  reservationDeficit!: number;
  @ApiProperty({
    description:
      '`reservationDeficit - overReserved`; distinto de cero es un desfasaje del déficit (se corrige con POST /stock/reconciliation/adjustments aunque `difference` sea 0)',
  })
  deficitDifference!: number;
  @ApiProperty({
    description:
      'Variación a aplicar al vendible para que cierre (-difference). Se aplica con POST /stock/reconciliation/adjustments',
  })
  correction!: number;
}

export class PedidoEntregadoSinMovimientoDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty() deliveredAt!: Date;
  @ApiProperty({ format: 'uuid' }) gasCylinderId!: string;
  @ApiProperty({ example: '10kg' }) gasCylinderType!: string;
  @ApiProperty() quantity!: number;
}

export class StockReconciliationDto {
  @ApiProperty() checkedAt!: Date;
  @ApiProperty({
    description:
      'true si todas las garrafas cumplen la invariante, ninguna tiene reservas por encima del físico y no hay entregas sin movimiento',
  })
  consistent!: boolean;
  @ApiProperty({ type: DiferenciaDeVendibleDto, isArray: true })
  cylinders!: DiferenciaDeVendibleDto[];
  @ApiProperty({
    type: PedidoEntregadoSinMovimientoDto,
    isArray: true,
    description:
      'Renglones de pedidos entregados desde que arrancó el módulo que no descontaron el físico (no había saldo donde sacar)',
  })
  deliveriesWithoutMovement!: PedidoEntregadoSinMovimientoDto[];
}

export class ReapplyDeliveriesResultDto {
  @ApiProperty({
    description: 'Pedidos entregados que no tenían su movimiento',
  })
  revisados!: number;
  @ApiProperty({
    description: 'Pedidos a los que se les descontó el físico ahora',
  })
  reaplicados!: number;
  @ApiProperty({ description: 'Pedidos que siguen sin saldo de donde sacar' })
  pendientes!: number;
}
