import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import {
  FechaCalendario,
  FechaCalendarioOpcional,
} from '../../employee/dto/fecha-calendario.decorator';
import {
  CommissionBasis,
  CommissionEntryType,
} from '../domain/commission.enums';

const aBooleano = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

export class CreateCommissionRuleDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Legajo del chofer. Sin él, la regla vale para todos.',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Garrafa. Sin ella, la regla vale para todos los productos.',
  })
  @IsOptional()
  @IsUUID()
  gasCylinderId?: string | null;

  @ApiProperty({
    enum: CommissionBasis,
    example: CommissionBasis.PER_UNIT,
    description:
      '`per_unit`: pesos por garrafa; `per_order`: pesos por pedido; `percent_of_total`: % del subtotal del renglón',
  })
  @IsEnum(CommissionBasis)
  basis!: CommissionBasis;

  @ApiProperty({
    example: 150,
    description:
      'Pesos o porcentaje (hasta 100) según la base. Hasta 4 decimales.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() !== '' ? Number(value) : value,
  )
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1_000_000)
  value!: number;

  @FechaCalendario('2026-11-01')
  validFrom!: string;

  @FechaCalendarioOpcional('2026-12-31', undefined)
  validTo?: string | null;
}

export class UpdateCommissionRuleDto {
  @ApiPropertyOptional({ enum: CommissionBasis })
  @IsOptional()
  @IsEnum(CommissionBasis)
  basis?: CommissionBasis;

  @ApiPropertyOptional({ example: 180 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() !== '' ? Number(value) : value,
  )
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1_000_000)
  value?: number;

  @FechaCalendarioOpcional('2026-11-01', undefined)
  validFrom?: string;

  /** `null` deja la regla sin fecha de fin. */
  @FechaCalendarioOpcional('2026-12-31', null)
  validTo?: string | null;

  @ApiPropertyOptional({ description: 'false la desactiva' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class QueryCommissionRuleDto extends PaginationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  gasCylinderId?: string;

  @ApiPropertyOptional({ description: 'Sólo las activas' })
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  activeOnly?: boolean;
}

export class CommissionRuleResponseDto {
  @ApiProperty() ruleId!: string;
  @ApiProperty({ type: String, nullable: true }) employeeId!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'null: todos los choferes',
  })
  employeeName!: string | null;
  @ApiProperty({ type: String, nullable: true }) gasCylinderId!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'null: todos los productos',
  })
  gasCylinderType!: string | null;
  @ApiProperty({ enum: CommissionBasis }) basis!: CommissionBasis;
  @ApiProperty({ example: 150 }) value!: number;
  @ApiProperty({ example: '2026-11-01' }) validFrom!: string;
  @ApiProperty({ type: String, nullable: true, example: '2026-12-31' })
  validTo!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class CommissionRulePageDto {
  @ApiProperty({ type: [CommissionRuleResponseDto] })
  data!: CommissionRuleResponseDto[];
  @ApiProperty({ example: 4 }) total!: number;
}

export class QueryCommissionEntryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Legajo del chofer' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({ enum: CommissionEntryType })
  @IsOptional()
  @IsEnum(CommissionEntryType)
  type?: CommissionEntryType;

  @FechaCalendarioOpcional('2026-11-01', undefined)
  from?: string;

  @FechaCalendarioOpcional('2026-11-30', undefined)
  to?: string;

  @ApiPropertyOptional({
    description: 'true: ya liquidados; false: pendientes de liquidar',
  })
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  liquidated?: boolean;
}

export class QueryMyCommissionsDto extends PaginationDto {
  @FechaCalendarioOpcional('2026-11-01', undefined)
  from?: string;

  @FechaCalendarioOpcional('2026-11-30', undefined)
  to?: string;
}

export class CommissionEntryResponseDto {
  @ApiProperty() entryId!: string;
  @ApiProperty() employeeId!: string;
  @ApiProperty({ example: 'Juan Pérez' }) employeeName!: string;
  @ApiProperty({ type: String, nullable: true }) deliveryId!: string | null;
  @ApiProperty({ enum: CommissionEntryType }) type!: CommissionEntryType;
  @ApiProperty({
    example: 450,
    description: 'Con signo: las deducciones son negativas',
  })
  amount!: number;
  @ApiProperty({ type: String, nullable: true }) orderId!: string | null;
  @ApiProperty({ type: String, nullable: true }) ruleId!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Liquidación que lo tomó, si ya se liquidó',
  })
  liquidationId!: string | null;
  @ApiProperty() description!: string;
  @ApiProperty() occurredAt!: Date;
}

export class CommissionEntryPageDto {
  @ApiProperty({ type: [CommissionEntryResponseDto] })
  data!: CommissionEntryResponseDto[];
  @ApiProperty({ example: 25 }) total!: number;
  @ApiProperty({
    example: 8450,
    description: 'Suma con signo de todos los asientos que cumplen el filtro',
  })
  totalAmount!: number;
}

export class MyCommissionsDto extends CommissionEntryPageDto {
  @ApiProperty({
    example: 3200,
    description: 'Lo todavía no liquidado, en el período',
  })
  pendingAmount!: number;
  @ApiProperty({ example: 5250, description: 'Lo ya liquidado, en el período' })
  liquidatedAmount!: number;
}
