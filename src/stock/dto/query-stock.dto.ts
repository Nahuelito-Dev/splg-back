import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { PickType } from '@nestjs/swagger';
import { FechaCalendarioOpcional } from '../../employee/dto/fecha-calendario.decorator';
import {
  StockAdjustmentReason,
  StockMovementReason,
  StockReferenceType,
} from '../domain/stock.enums';

export class QueryStockBalanceDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  carId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  gasCylinderId?: string;

  @ApiPropertyOptional({
    description:
      'true también trae los saldos en cero (default: sólo los positivos)',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  includeZero?: boolean;
}

export class QueryStockMovementDto extends PickType(PaginationDto, [
  'page',
  'limit',
] as const) {
  @ApiPropertyOptional({ format: 'uuid', description: 'Tipo de garrafa' })
  @IsOptional()
  @IsUUID()
  gasCylinderId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Movimientos que salen de o entran a esta ubicación',
  })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ enum: StockMovementReason })
  @IsOptional()
  @IsEnum(StockMovementReason)
  reason?: StockMovementReason;

  @ApiPropertyOptional({ enum: StockReferenceType })
  @IsOptional()
  @IsEnum(StockReferenceType)
  referenceType?: StockReferenceType;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Movimientos de un lote',
  })
  @IsOptional()
  @IsUUID()
  batchId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Movimientos de un documento (por ejemplo el id de una carga de camión, con referenceType)',
  })
  @IsOptional()
  @IsUUID()
  referenceId?: string;

  @FechaCalendarioOpcional('2026-10-01', undefined)
  from?: string;

  @FechaCalendarioOpcional('2026-10-31', undefined)
  to?: string;
}

export class QueryStockAdjustmentDto extends PickType(PaginationDto, [
  'page',
  'limit',
] as const) {
  @ApiPropertyOptional({ enum: StockAdjustmentReason })
  @IsOptional()
  @IsEnum(StockAdjustmentReason)
  reason?: StockAdjustmentReason;

  @FechaCalendarioOpcional('2026-10-01', undefined)
  from?: string;

  @FechaCalendarioOpcional('2026-10-31', undefined)
  to?: string;
}
