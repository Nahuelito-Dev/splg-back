import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNumber,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_COSTO, MAX_RENGLONES, MAX_UNIDADES } from './purchase-limits';

export class PurchaseLineToPreviewDto {
  @ApiProperty({ example: 40, description: 'Unidades del renglón' })
  @IsInt()
  @Min(0)
  @Max(MAX_UNIDADES)
  quantity!: number;

  @ApiProperty({ example: 5200.5, description: 'Costo por unidad' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_COSTO)
  unitCost!: number;
}

/** Los renglones de una orden o remito de los que el back calcula el total. */
export class PreviewPurchaseTotalDto {
  @ApiProperty({ type: PurchaseLineToPreviewDto, isArray: true })
  @IsArray()
  @ArrayMaxSize(MAX_RENGLONES)
  @ValidateNested({ each: true })
  @Type(() => PurchaseLineToPreviewDto)
  items!: PurchaseLineToPreviewDto[];
}

export class PurchaseLinePreviewDto {
  @ApiProperty({ example: 208020, description: 'Cantidad × costo unitario' })
  subtotal!: number;
}

export class PurchaseTotalPreviewDto {
  @ApiProperty({
    type: PurchaseLinePreviewDto,
    isArray: true,
    description: 'Un subtotal por renglón, en el mismo orden',
  })
  items!: PurchaseLinePreviewDto[];
  @ApiProperty({
    example: 208020,
    description:
      'Σ cantidad × costo unitario a 2 decimales: el total con el que se guarda la orden o el remito',
  })
  total!: number;
}
