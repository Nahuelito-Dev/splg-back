import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import { WarehouseKind } from '../domain/stock.enums';
import { StockBalanceDto } from './stock-response.dto';

const aBooleano = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

export class CreateWarehouseDto {
  @ApiProperty({ example: 'Depósito central', maxLength: 80 })
  @TextoNoVacio()
  @MaxLength(80)
  name!: string;

  @ApiProperty({
    example: 'CENTRAL',
    description:
      'Código corto, único entre los depósitos vigentes. Se guarda en mayúsculas.',
    maxLength: 12,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(/^[A-Z0-9_-]{1,12}$/, {
    message: 'code: hasta 12 letras, dígitos, guion o guion bajo',
  })
  code!: string;

  @ApiPropertyOptional({ enum: WarehouseKind, default: WarehouseKind.DEPOT })
  @IsOptional()
  @IsEnum(WarehouseKind)
  kind?: WarehouseKind;

  @ApiPropertyOptional({ example: 'Av. Siempreviva 742' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @ApiPropertyOptional({
    description:
      'Lo deja como predeterminado (el que usa la entrega cuando el camión no tiene stock). El primero que se crea lo es siempre.',
  })
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateWarehouseDto extends PartialType(
  OmitType(CreateWarehouseDto, ['kind'] as const),
) {
  @ApiPropertyOptional({
    enum: WarehouseKind,
    description: 'Sólo cambia si se envía; si falta, conserva el tipo actual',
  })
  @IsOptional()
  @IsEnum(WarehouseKind)
  kind?: WarehouseKind;

  @ApiPropertyOptional({
    description:
      'false lo deja fuera de las listas de operación; no se puede con el predeterminado',
  })
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  isActive?: boolean;
}

export class QueryWarehouseDto {
  @ApiPropertyOptional({
    description:
      'true incluye los depósitos inactivos (default: sólo los activos)',
  })
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  includeInactive?: boolean;
}

export class WarehouseResponseDto {
  @ApiProperty({ format: 'uuid' }) warehouseId!: string;
  @ApiProperty({
    format: 'uuid',
    description: 'Ubicación de stock del depósito',
  })
  locationId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ enum: WarehouseKind }) kind!: WarehouseKind;
  @ApiProperty({ nullable: true, type: String }) address!: string | null;
  @ApiProperty() isDefault!: boolean;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class WarehouseDetailDto extends WarehouseResponseDto {
  @ApiProperty({
    type: () => StockBalanceDto,
    isArray: true,
    description: 'Saldos del depósito (sólo los positivos)',
  })
  balances!: StockBalanceDto[];
}
