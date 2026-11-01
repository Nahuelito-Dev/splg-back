import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, MaxLength } from 'class-validator';
import { FechaCalendarioOpcional } from '../../employee/dto/fecha-calendario.decorator';
import { Importe } from '../../common/decorators/importe.decorator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { CashSessionStatus } from '../domain/cash.enums';
import { CashMovementResponseDto } from './cash-movement.dto';

export class OpenCashSessionDto {
  @ApiProperty({
    example: 5000,
    description:
      'Efectivo con que se abre la caja. Si no coincide con el saldo del libro se asienta un ajuste de apertura.',
  })
  @Importe(0)
  openingAmount!: number;
}

export class CloseCashSessionDto {
  @ApiProperty({
    example: 18250,
    description: 'Lo que se contó físicamente en la caja',
  })
  @Importe(0)
  countedAmount!: number;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @TextoNoVacio()
  @MaxLength(500)
  notes?: string;
}

export class PreviewCloseCashSessionDto {
  @ApiProperty({
    example: 18250,
    description: 'Lo que se está contando en la caja (0 o más)',
  })
  @Importe(0)
  countedAmount!: number;
}

export class CloseCashSessionPreviewDto {
  @ApiProperty({ example: 5000, description: 'Monto con que se abrió' })
  openingAmount!: number;
  @ApiProperty({
    example: 14000,
    description: 'Entradas de la sesión, sin el ajuste de apertura',
  })
  totalIn!: number;
  @ApiProperty({
    example: 750,
    description: 'Salidas de la sesión, sin el ajuste de apertura',
  })
  totalOut!: number;
  @ApiProperty({
    example: 18250,
    description: 'Apertura + entradas − salidas: lo que debería haber',
  })
  expectedAmount!: number;
  @ApiProperty({ example: 18000 }) countedAmount!: number;
  @ApiProperty({
    example: -250,
    description:
      'Contado − esperado: la misma cuenta que se guarda al cerrar (negativa: faltante; positiva: sobrante)',
  })
  difference!: number;
}

export class QueryCashSessionDto extends PaginationDto {
  @FechaCalendarioOpcional('2026-10-01', undefined)
  from?: string;

  @FechaCalendarioOpcional('2026-10-31', undefined)
  to?: string;
}

export class CashSessionResponseDto {
  @ApiProperty() sessionId!: string;
  @ApiProperty() cashBoxId!: string;
  @ApiProperty({ example: 'Caja central' }) cashBoxName!: string;
  @ApiProperty({ enum: CashSessionStatus }) status!: CashSessionStatus;
  @ApiProperty() openedAt!: Date;
  @ApiProperty() openedByUserId!: string;
  @ApiProperty({ example: 5000 }) openingAmount!: number;
  @ApiProperty({ type: Date, nullable: true }) closedAt!: Date | null;
  @ApiProperty({ type: String, nullable: true }) closedByUserId!: string | null;
  @ApiProperty({ type: Number, nullable: true }) expectedAmount!: number | null;
  @ApiProperty({ type: Number, nullable: true }) countedAmount!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Contado menos esperado: negativa es faltante',
  })
  difference!: number | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
}

export class CashSessionPageDto {
  @ApiProperty({ type: [CashSessionResponseDto] })
  data!: CashSessionResponseDto[];
  @ApiProperty({ example: 8 }) total!: number;
}

export class CashSessionDetailDto extends CashSessionResponseDto {
  @ApiProperty({
    example: 18250,
    description: 'Saldo actual de la caja según el libro',
  })
  currentBalance!: number;
  @ApiProperty({ example: 14000 }) totalIn!: number;
  @ApiProperty({ example: 750 }) totalOut!: number;
  @ApiProperty({
    type: [CashMovementResponseDto],
    description: 'Movimientos de la sesión, del más viejo al más nuevo',
  })
  movements!: CashMovementResponseDto[];
}
