import { aCentavos, dec } from '../../common/utils/dinero';
import { CashBoxService } from '../../cash/application/cash-box.service';
import { CashIncomeStatementService } from '../../cash/application/cash-income-statement.service';
import { CashMovementService } from '../../cash/application/cash-movement.service';
import { CashMapper } from '../../cash/cash.mapper';
import { QueryIncomeStatementDto } from '../../cash/dto/cash-income-statement.dto';
import { QueryCashBoxDto } from '../../cash/dto/cash-box.dto';
import type { CashBoxResponseDto } from '../../cash/dto/cash-box.dto';
import { QueryCashMovementV2Dto } from '../../cash/dto/cash-movement.dto';
import type { CashMovementResponseDto } from '../../cash/dto/cash-movement.dto';
import { CommissionMapper } from '../../commission/presentation/commission.mapper';
import { QueryDriverLiquidationDto } from '../../commission/dto/driver-liquidation.dto';
import type { DriverLiquidationResponseDto } from '../../commission/dto/driver-liquidation.dto';
import { DriverLiquidationService } from '../../commission/application/driver-liquidation.service';
import { CustomerAccountQueryService } from '../../customer-account/application/customer-account-query.service';
import { QueryCustomerAccountDto } from '../../customer-account/dto/customer-account.dto';
import type { CustomerAccountResponseDto } from '../../customer-account/dto/customer-account.dto';
import { DriverSettlementQueryService } from '../../driver-settlement/application/driver-settlement-query.service';
import { QueryDriverSettlementDto } from '../../driver-settlement/dto/driver-settlement.dto';
import type { DriverSettlementResponseDto } from '../../driver-settlement/dto/driver-settlement.dto';
import type { FuenteDeExporte } from '../export.types';
import {
  booleano,
  codigo,
  entero,
  fecha,
  fechaHora,
  moneda,
  texto,
} from './columnas';
import { fuente, porPagina } from './fuente';

/** Una fila del exporte del resultado: el total, una categoría, un período o una caja. */
export interface FilaDeResultado {
  seccion: 'Total' | 'Categoría' | 'Período' | 'Caja';
  concepto: string;
  ingresos: number;
  egresos: number;
  movimientos: number | null;
}

export interface ServiciosDeFinanzas {
  cashBoxes: CashBoxService;
  cashMovements: CashMovementService;
  incomeStatement: CashIncomeStatementService;
  accounts: CustomerAccountQueryService;
  settlements: DriverSettlementQueryService;
  liquidations: DriverLiquidationService;
}

export function fuentesDeFinanzas(s: ServiciosDeFinanzas): FuenteDeExporte[] {
  return [
    fuente<QueryCashBoxDto, CashBoxResponseDto>({
      recurso: 'cajas',
      descripcion: 'Cajas con su saldo (mismos filtros que GET /cash-boxes)',
      query: QueryCashBoxDto,
      paginar: porPagina,
      leer: async (query, distribuidoraId) => {
        const r = await s.cashBoxes.findAll(distribuidoraId, query);
        return {
          filas: r.data.map((c) => CashMapper.caja(c.caja, c.openSessionId)),
          total: r.total,
        };
      },
      columnas: [
        texto('Caja', (c) => c.name),
        texto('Tipo', (c) => c.kind),
        moneda('Saldo', (c) => c.balance),
        booleano('Exige sesión', (c) => c.requiresSession),
        booleano('Sesión abierta', (c) => c.openSessionId !== null),
        booleano('Activa', (c) => c.isActive),
        fechaHora('Alta', (c) => c.createdAt),
      ],
    }),

    fuente<QueryCashMovementV2Dto, CashMovementResponseDto>({
      recurso: 'movimientos-caja',
      descripcion:
        'Movimientos de caja (mismos filtros que GET /cash-movements)',
      query: QueryCashMovementV2Dto,
      paginar: porPagina,
      leer: async (query, distribuidoraId) => {
        const r = await s.cashMovements.consultar(distribuidoraId, query);
        return {
          filas: r.data.map((m) => CashMapper.movimiento(m.movimiento, m)),
          total: r.total,
        };
      },
      columnas: [
        fechaHora('Fecha', (m) => m.occurredAt),
        texto('Caja', (m) => m.cashBoxName),
        texto('Sentido', (m) => m.direction),
        moneda('Importe', (m) => m.amount),
        texto('Categoría', (m) => m.categoryName),
        texto('Medio', (m) => m.method),
        texto('Descripción', (m) => m.description, 40),
        texto('Origen', (m) => m.referenceType),
        codigo('Referencia', (m) => m.referenceId, 38),
        booleano('Anulado', (m) => m.reversed),
        codigo('Anula al movimiento', (m) => m.reversesMovementId, 38),
      ],
    }),

    fuente<QueryIncomeStatementDto, FilaDeResultado>({
      recurso: 'income-statement',
      descripcion:
        'Ingresos y egresos de un período: total, por categoría, por período y por caja (mismos filtros que GET /finance/income-statement)',
      query: QueryIncomeStatementDto,
      leer: async (query, distribuidoraId) => {
        const r = await s.incomeStatement.consultar(distribuidoraId, query);
        const filas: FilaDeResultado[] = [
          {
            seccion: 'Total',
            concepto: `${r.from} a ${r.to}`,
            ingresos: r.totals.income,
            egresos: r.totals.expense,
            movimientos: null,
          },
          ...r.byCategory.map((c) => ({
            seccion: 'Categoría' as const,
            concepto: c.name,
            ingresos: c.direction === 'in' ? c.amount : 0,
            egresos: c.direction === 'out' ? c.amount : 0,
            movimientos: c.count,
          })),
          ...r.byPeriod.map((p) => ({
            seccion: 'Período' as const,
            concepto: p.period,
            ingresos: p.income,
            egresos: p.expense,
            movimientos: null,
          })),
          ...r.byCashBox.map((c) => ({
            seccion: 'Caja' as const,
            concepto: c.name,
            ingresos: c.income,
            egresos: c.expense,
            movimientos: null,
          })),
        ];
        return { filas, total: filas.length };
      },
      columnas: [
        texto('Sección', (f) => f.seccion),
        texto('Concepto', (f) => f.concepto, 36),
        moneda('Ingresos', (f) => f.ingresos),
        moneda('Egresos', (f) => f.egresos),
        moneda('Resultado', (f) => aCentavos(dec(f.ingresos).minus(f.egresos))),
        entero('Movimientos', (f) => f.movimientos),
      ],
    }),

    fuente<QueryCustomerAccountDto, CustomerAccountResponseDto>({
      recurso: 'cuentas-corrientes',
      descripcion:
        'Cuentas corrientes (mismos filtros que GET /customer-accounts)',
      query: QueryCustomerAccountDto,
      paginar: porPagina,
      leer: async (query, distribuidoraId) => {
        const r = await s.accounts.findAll(distribuidoraId, query);
        return { filas: r.data, total: r.total };
      },
      columnas: [
        texto('Razón social', (a) => a.businessName),
        codigo('CUIT', (a) => a.taxId),
        texto('Condición fiscal', (a) => a.taxCondition),
        texto('Cliente', (a) => a.customerName),
        texto('Email', (a) => a.customerEmail),
        texto('Estado', (a) => a.status),
        moneda('Límite de crédito', (a) => a.creditLimit),
        entero('Plazo (días)', (a) => a.paymentTermsDays),
        moneda('Saldo', (a) => a.balance),
        moneda('Pedidos pendientes', (a) => a.pendingOrdersAmount),
        moneda('Crédito disponible', (a) => a.availableCredit),
        moneda('Deuda vencida', (a) => a.overdueAmount),
        fechaHora('Alta', (a) => a.createdAt),
      ],
    }),

    fuente<QueryDriverSettlementDto, DriverSettlementResponseDto>({
      recurso: 'rendiciones',
      descripcion:
        'Rendiciones de los choferes (mismos filtros que GET /driver-settlements)',
      query: QueryDriverSettlementDto,
      paginar: porPagina,
      leer: async (query, distribuidoraId) => {
        const r = await s.settlements.findAll(distribuidoraId, query);
        return { filas: r.data, total: r.total };
      },
      columnas: [
        entero('N°', (r) => r.number),
        fecha('Día', (r) => r.businessDate),
        texto('Chofer', (r) => r.driverName),
        texto('Estado', (r) => r.status),
        moneda('Esperado', (r) => r.expectedCash),
        moneda('Declarado', (r) => r.declaredCash),
        moneda('Gastos del chofer', (r) => r.driverExpenses),
        moneda('Diferencia', (r) => r.difference),
        texto('Resolución de la diferencia', (r) => r.differenceResolution),
        fechaHora('Enviada', (r) => r.submittedAt),
        fechaHora('Aprobada', (r) => r.approvedAt),
        texto('Notas', (r) => r.notes, 36),
      ],
    }),

    fuente<QueryDriverLiquidationDto, DriverLiquidationResponseDto>({
      recurso: 'liquidaciones',
      descripcion:
        'Liquidaciones de choferes (mismos filtros que GET /driver-liquidations)',
      query: QueryDriverLiquidationDto,
      paginar: porPagina,
      leer: async (query, distribuidoraId) => {
        const r = await s.liquidations.findAll(distribuidoraId, query);
        return {
          filas: r.data.map((l) => CommissionMapper.liquidacion(l)),
          total: r.total,
        };
      },
      columnas: [
        entero('N°', (l) => l.number),
        texto('Empleado', (l) => l.employeeName),
        fecha('Desde', (l) => l.periodFrom),
        fecha('Hasta', (l) => l.periodTo),
        moneda('Bruto', (l) => l.gross),
        moneda('Deducciones', (l) => l.deductions),
        moneda('Neto', (l) => l.net),
        texto('Estado', (l) => l.status),
        fechaHora('Aprobada', (l) => l.approvedAt),
        fechaHora('Pagada', (l) => l.paidAt),
        fechaHora('Anulada', (l) => l.voidedAt),
        fechaHora('Alta', (l) => l.createdAt),
      ],
    }),
  ];
}
