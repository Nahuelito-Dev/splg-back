import { ApiProperty } from '@nestjs/swagger';
import { CashBoxKind } from '../../cash/domain/cash.enums';
import { FechaCalendarioOpcional } from '../../employee/dto/fecha-calendario.decorator';

export class QueryFinanceDashboardDto {
  @FechaCalendarioOpcional('2026-11-03', undefined)
  date?: string;
}

export class DashboardCashBoxDto {
  @ApiProperty() cashBoxId!: string;
  @ApiProperty({ example: 'Caja central' }) name!: string;
  @ApiProperty({ enum: CashBoxKind }) kind!: CashBoxKind;
  @ApiProperty({ example: 152000 }) balance!: number;
  @ApiProperty() hasOpenSession!: boolean;
}

export class DashboardMovementsDto {
  @ApiProperty({
    example: 180000,
    description: 'Entradas del día, sin transferencias entre cajas',
  })
  income!: number;
  @ApiProperty({ example: 42000 }) expense!: number;
  @ApiProperty({ example: 17 }) count!: number;
}

export class DashboardSettlementsDto {
  @ApiProperty({ example: 2, description: 'Abiertas del día' }) open!: number;
  @ApiProperty({
    example: 1,
    description: 'Presentadas del día, a la espera de aprobación',
  })
  submitted!: number;
  @ApiProperty({ example: 3 }) approved!: number;
  @ApiProperty({
    example: 1,
    description: 'Abiertas o presentadas de días anteriores: sin cerrar',
  })
  overdue!: number;
  @ApiProperty({
    example: 38000,
    description: 'Efectivo declarado en rendiciones presentadas, sin aprobar',
  })
  pendingCash!: number;
}

export class DashboardReceivablesDto {
  @ApiProperty({ example: 420000 }) totalDebt!: number;
  @ApiProperty({
    example: 90000,
    description: 'Con vencimiento anterior a hoy',
  })
  overdueDebt!: number;
  @ApiProperty({ example: 7 }) accountsWithDebt!: number;
}

export class DashboardCommissionsDto {
  @ApiProperty({
    example: 63000,
    description: 'Lo devengado y todavía no liquidado',
  })
  pendingToLiquidate!: number;
  @ApiProperty({
    example: 4,
    description: 'Choferes con comisiones sin liquidar',
  })
  employees!: number;
}

export class FinanceDashboardDto {
  @ApiProperty({ example: '2026-11-03' }) date!: string;
  @ApiProperty({ type: [DashboardCashBoxDto] })
  cashBoxes!: DashboardCashBoxDto[];
  @ApiProperty({
    example: 152000,
    description: 'Suma de los saldos de todas las cajas activas',
  })
  totalBalance!: number;
  @ApiProperty({ type: DashboardMovementsDto })
  movements!: DashboardMovementsDto;
  @ApiProperty({ type: DashboardSettlementsDto })
  settlements!: DashboardSettlementsDto;
  @ApiProperty({ type: DashboardReceivablesDto })
  receivables!: DashboardReceivablesDto;
  @ApiProperty({ type: DashboardCommissionsDto })
  commissions!: DashboardCommissionsDto;
}
