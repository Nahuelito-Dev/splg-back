import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { FechaCalendarioOpcional } from '../../employee/dto/fecha-calendario.decorator';
import { Importe } from '../../common/decorators/importe.decorator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { MotivoObligatorio } from '../../purchase/dto/motivo.decorator';
import {
  CashDirection,
  CashMethod,
  CashReferenceType,
} from '../domain/cash.enums';

export class CreateCashMovementDto {
  @ApiProperty({ description: 'Caja donde entra o de donde sale el dinero' })
  @IsUUID()
  cashBoxId!: string;

  @ApiProperty({ enum: CashDirection, example: CashDirection.OUT })
  @IsEnum(CashDirection)
  direction!: CashDirection;

  @ApiProperty({ example: 2500.5, description: 'Mayor que cero, 2 decimales' })
  @Importe()
  amount!: number;

  @ApiProperty({
    description: 'Categoría del mismo sentido que el movimiento',
  })
  @IsUUID()
  categoryId!: string;

  @ApiPropertyOptional({ enum: CashMethod, default: CashMethod.CASH })
  @IsOptional()
  @IsEnum(CashMethod)
  method?: CashMethod;

  @ApiProperty({ example: 'Compra de artículos de limpieza', maxLength: 255 })
  @TextoNoVacio()
  @MaxLength(255)
  description!: string;
}

export class TransferCashDto {
  @ApiProperty({ description: 'Caja de la que sale el dinero' })
  @IsUUID()
  fromCashBoxId!: string;

  @ApiProperty({ description: 'Caja a la que entra el dinero' })
  @IsUUID()
  toCashBoxId!: string;

  @ApiProperty({ example: 10000 })
  @Importe()
  amount!: number;

  @ApiPropertyOptional({ example: 'Depósito del día', maxLength: 255 })
  @IsOptional()
  @TextoNoVacio()
  @MaxLength(255)
  description?: string;
}

export class ReverseCashMovementDto {
  @ApiProperty({ example: 'Se cargó dos veces', maxLength: 500 })
  @MotivoObligatorio()
  reason!: string;
}

export class QueryCashMovementDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Sólo los de esta caja' })
  @IsOptional()
  @IsUUID()
  cashBoxId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ enum: CashDirection })
  @IsOptional()
  @IsEnum(CashDirection)
  direction?: CashDirection;

  @ApiPropertyOptional({ enum: CashReferenceType })
  @IsOptional()
  @IsEnum(CashReferenceType)
  referenceType?: CashReferenceType;

  /** Día inicial (hora argentina), inclusive. */
  @FechaCalendarioOpcional('2026-10-01', undefined)
  from?: string;

  /** Día final (hora argentina), inclusive. */
  @FechaCalendarioOpcional('2026-10-31', undefined)
  to?: string;
}

const aBooleano = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/** Los filtros del listado en la API v2 (la v1 quedó congelada). */
export class QueryCashMovementV2Dto extends QueryCashMovementDto {
  @ApiPropertyOptional({
    description:
      'Sólo los movimientos que cuentan como ingreso o egreso en `GET /v2/finance/income-statement`: sin transferencias entre cajas ni carga inicial',
  })
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  countsForResult?: boolean;
}

export class CashMovementResponseDto {
  @ApiProperty() movementId!: string;
  @ApiProperty() cashBoxId!: string;
  @ApiProperty({ example: 'Caja central' }) cashBoxName!: string;
  @ApiProperty({ type: String, nullable: true }) sessionId!: string | null;
  @ApiProperty({ enum: CashDirection }) direction!: CashDirection;
  @ApiProperty({ example: 2500.5 }) amount!: number;
  @ApiProperty() categoryId!: string;
  @ApiProperty({ example: 'Rendición de chofer' }) categoryName!: string;
  @ApiProperty({ enum: CashMethod }) method!: CashMethod;
  @ApiProperty() occurredAt!: Date;
  @ApiProperty() description!: string;
  @ApiProperty({ enum: CashReferenceType }) referenceType!: CashReferenceType;
  @ApiProperty({ type: String, nullable: true }) referenceId!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Si es una anulación, el movimiento que anula',
  })
  reversesMovementId!: string | null;
  @ApiProperty({
    description: 'true si otro movimiento ya lo anuló',
  })
  reversed!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Quién lo registró; null en los movimientos que se asientan solos (webhook, devolución de Mercado Pago)',
  })
  createdByUserId!: string | null;
  @ApiProperty() createdAt!: Date;
}

/** El movimiento en la API v2: suma el pedido del que nace (API v1 congelada). */
export class CashMovementV2ResponseDto extends CashMovementResponseDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'El pedido al que pertenece el movimiento cuando nace de un cobro de venta (efectivo, Mercado Pago, comisión, devolución, transferencia o seña); null en los demás',
  })
  orderId!: string | null;
}

export class CashMovementV2PageDto {
  @ApiProperty({ type: [CashMovementV2ResponseDto] })
  data!: CashMovementV2ResponseDto[];
  @ApiProperty({ example: 40 }) total!: number;
}

export class CashMovementPageDto {
  @ApiProperty({ type: [CashMovementResponseDto] })
  data!: CashMovementResponseDto[];
  @ApiProperty({ example: 40 }) total!: number;
}

export class CashTransferResponseDto {
  @ApiProperty({ type: CashMovementResponseDto })
  out!: CashMovementResponseDto;
  @ApiProperty({ type: CashMovementResponseDto })
  in!: CashMovementResponseDto;
}
