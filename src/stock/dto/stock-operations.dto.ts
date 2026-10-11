import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import { StockAdjustmentReason, StockCondition } from '../domain/stock.enums';
import { MOTIVOS_DE_AJUSTE } from '../domain/stock-rules';

const MAX_UNIDADES = 100_000;
const MAX_ITEMS = 50;

/** Una ubicación se nombra con el depósito o con el vehículo, uno solo. */
export class UbicacionDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Un depósito' })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Un vehículo (el camión del chofer): se indica su carId',
  })
  @IsOptional()
  @IsUUID()
  carId?: string;
}

export class TransferItemDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  gasCylinderId!: string;

  @ApiPropertyOptional({
    enum: StockCondition,
    default: StockCondition.FULL,
  })
  @IsOptional()
  @IsEnum(StockCondition)
  condition?: StockCondition;

  @ApiProperty({ example: 10, minimum: 1, maximum: MAX_UNIDADES })
  @IsInt()
  @Min(1)
  @Max(MAX_UNIDADES)
  quantity!: number;
}

export class CreateTransferDto {
  @ApiProperty({ type: UbicacionDto })
  @ValidateNested()
  @Type(() => UbicacionDto)
  from!: UbicacionDto;

  @ApiProperty({ type: UbicacionDto })
  @ValidateNested()
  @Type(() => UbicacionDto)
  to!: UbicacionDto;

  @ApiProperty({ type: TransferItemDto, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => TransferItemDto)
  items!: TransferItemDto[];

  @ApiPropertyOptional({ example: 'Carga de la mañana' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;
}

export class AdjustmentItemDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  gasCylinderId!: string;

  @ApiProperty({ enum: StockCondition })
  @IsEnum(StockCondition)
  condition!: StockCondition;

  @ApiProperty({
    example: -2,
    description:
      'Cuánto cambia el saldo de esa condición (entero distinto de cero). ' +
      'Merma, fuga, rotura y pérdida: negativo. Encontrado: positivo. ' +
      'Corrección de conteo: cualquiera. Rotura: condición `full`; las llenas ' +
      'pasan a defectuosas en la misma ubicación.',
  })
  @IsInt()
  @Min(-MAX_UNIDADES)
  @Max(MAX_UNIDADES)
  quantityDelta!: number;
}

export class CreateAdjustmentDto {
  @ApiProperty({ type: UbicacionDto })
  @ValidateNested()
  @Type(() => UbicacionDto)
  location!: UbicacionDto;

  @ApiProperty({
    enum: MOTIVOS_DE_AJUSTE,
    example: StockAdjustmentReason.SHRINKAGE,
  })
  @IsIn(MOTIVOS_DE_AJUSTE)
  reason!: StockAdjustmentReason;

  @ApiProperty({
    example: 'Dos garrafas con la válvula floja, se descartaron',
    description: 'Obligatoria: explica por qué cambia el stock',
  })
  @TextoNoVacio()
  @MaxLength(500)
  notes!: string;

  @ApiProperty({ type: AdjustmentItemDto, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => AdjustmentItemDto)
  items!: AdjustmentItemDto[];
}

export class InitialCountItemDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  gasCylinderId!: string;

  @ApiProperty({ example: 40, description: 'Llenas contadas' })
  @IsInt()
  @Min(0)
  @Max(MAX_UNIDADES)
  full!: number;

  @ApiPropertyOptional({
    example: 25,
    default: 0,
    description: 'Vacías contadas',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_UNIDADES)
  empty?: number;

  @ApiPropertyOptional({
    example: 1,
    default: 0,
    description: 'Defectuosas contadas',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_UNIDADES)
  defective?: number;
}

export class CreateInitialCountDto {
  @ApiProperty({ format: 'uuid', description: 'Depósito que se cuenta' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({
    type: InitialCountItemDto,
    isArray: true,
    description:
      'Lo que hay físicamente de cada tipo. Los tipos que no se listan no se tocan.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => InitialCountItemDto)
  items!: InitialCountItemDto[];

  @ApiPropertyOptional({ example: 'Toma de inventario de apertura' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class ReverseBatchDto {
  @ApiPropertyOptional({ example: 'Se cargó al camión equivocado' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;
}

export class CreateReconciliationAdjustmentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  gasCylinderId!: string;

  @ApiProperty({
    example: 'El vendible se tocó a mano antes del módulo de stock',
    description: 'Obligatoria: explica por qué se corrige el vendible',
  })
  @TextoNoVacio()
  @MaxLength(500)
  notes!: string;

  @ApiPropertyOptional({
    example: 4,
    description:
      '`difference` que vio el administrador en la conciliación. Si cambió mientras tanto, responde 409 en vez de corregir un número viejo.',
  })
  @IsOptional()
  @IsInt()
  expectedDifference?: number;
}
