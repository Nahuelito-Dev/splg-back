import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { FechaCalendario } from '../../employee/dto/fecha-calendario.decorator';
import { CashBoxKind, CashSystemCode } from '../domain/cash.enums';

export enum IncomeStatementGroupBy {
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
}

export class QueryIncomeStatementDto {
  /** Día inicial (hora argentina), inclusive. */
  @FechaCalendario('2026-10-01')
  from!: string;

  /** Día final (hora argentina), inclusive. El rango admite hasta 366 días. */
  @FechaCalendario('2026-10-31')
  to!: string;

  @ApiPropertyOptional({
    enum: IncomeStatementGroupBy,
    default: IncomeStatementGroupBy.DAY,
    description:
      'Cómo se agrupa el resultado por período: día, semana (lunes) o mes',
  })
  @IsOptional()
  @IsEnum(IncomeStatementGroupBy)
  groupBy?: IncomeStatementGroupBy;

  @ApiPropertyOptional({ description: 'Sólo los movimientos de esta caja' })
  @IsOptional()
  @IsUUID()
  cashBoxId?: string;
}

export class IncomeStatementTotalsDto {
  @ApiProperty({ example: 180000 }) income!: number;
  @ApiProperty({ example: 42000 }) expense!: number;
  @ApiProperty({ example: 138000, description: 'Ingresos menos egresos' })
  net!: number;
}

export class IncomeStatementCategoryDto {
  @ApiProperty() categoryId!: string;
  @ApiProperty({ example: 'Cobro de pedido' }) name!: string;
  @ApiProperty({ enum: CashSystemCode, nullable: true, type: String })
  systemCode!: CashSystemCode | null;
  @ApiProperty({
    enum: ['in', 'out'],
    description: '`in` es un ingreso y `out` un egreso',
  })
  direction!: 'in' | 'out';
  @ApiProperty({ example: 95000 }) amount!: number;
  @ApiProperty({ example: 12, description: 'Cantidad de movimientos' })
  count!: number;
}

export class IncomeStatementPeriodDto {
  @ApiProperty({
    example: '2026-10-05',
    description:
      'Primer día del período dentro del rango: el propio día, el lunes de la semana o el día 1 del mes (el primer período arranca en `from`)',
  })
  period!: string;
  @ApiProperty({ example: 50000 }) income!: number;
  @ApiProperty({ example: 12000 }) expense!: number;
  @ApiProperty({ example: 38000 }) net!: number;
}

export class IncomeStatementCashBoxDto {
  @ApiProperty() cashBoxId!: string;
  @ApiProperty({ example: 'Caja central' }) name!: string;
  @ApiProperty({ enum: CashBoxKind }) kind!: CashBoxKind;
  @ApiProperty({ example: 120000 }) income!: number;
  @ApiProperty({ example: 30000 }) expense!: number;
}

export class IncomeStatementInitialLoadDto {
  @ApiProperty({
    example: 50000,
    description:
      'Carga inicial de las cajas en el período (la apertura de su primera sesión, sin movimientos previos): no es ingreso ni egreso',
  })
  amount!: number;
  @ApiProperty({ example: 1 }) count!: number;
}

export class IncomeStatementDto {
  @ApiProperty({ example: '2026-10-01' }) from!: string;
  @ApiProperty({ example: '2026-10-31' }) to!: string;
  @ApiProperty({ enum: IncomeStatementGroupBy })
  groupBy!: IncomeStatementGroupBy;
  @ApiProperty({ type: IncomeStatementTotalsDto })
  totals!: IncomeStatementTotalsDto;
  @ApiProperty({ type: IncomeStatementInitialLoadDto })
  initialLoad!: IncomeStatementInitialLoadDto;
  @ApiProperty({
    type: [IncomeStatementCategoryDto],
    description:
      'Un contraasiento resta dentro de la categoría de su original, así que un importe puede ser negativo',
  })
  byCategory!: IncomeStatementCategoryDto[];
  @ApiProperty({
    type: [IncomeStatementPeriodDto],
    description: 'Incluye los períodos sin movimientos, en cero',
  })
  byPeriod!: IncomeStatementPeriodDto[];
  @ApiProperty({ type: [IncomeStatementCashBoxDto] })
  byCashBox!: IncomeStatementCashBoxDto[];
}
