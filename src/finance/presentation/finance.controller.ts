import { Controller, Get, Query, Version } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { CashIncomeStatementService } from '../../cash/application/cash-income-statement.service';
import {
  IncomeStatementDto,
  QueryIncomeStatementDto,
} from '../../cash/dto/cash-income-statement.dto';
import { FinanceService } from '../application/finance.service';
import {
  FinanceDashboardDto,
  QueryFinanceDashboardDto,
} from '../dto/finance.dto';

/** Tablero financiero (CU-245). */
@ApiTags('Finanzas · Tablero')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('finance')
export class FinanceController {
  constructor(
    private readonly finanzas: FinanceService,
    private readonly resultado: CashIncomeStatementService,
  ) {}

  @Get('dashboard')
  @ApiOperation({
    summary: 'Tablero financiero',
    description:
      'Saldo de cada caja, movimientos y rendiciones del día (hora argentina), deuda total y vencida de los clientes y comisiones por liquidar. Lee los saldos guardados, no recalcula los libros.',
  })
  @ApiOkResponse({ type: FinanceDashboardDto })
  @ApiBadRequestResponse({ description: 'La fecha no es válida' })
  dashboard(
    @Query() query: QueryFinanceDashboardDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FinanceDashboardDto> {
    return this.finanzas.dashboard(distributorId, query.date);
  }

  @Get('income-statement')
  @Version('2')
  @ApiOperation({
    summary: 'Ingresos y egresos de un período',
    description:
      'Cuánto entró y cuánto salió de la caja entre `from` y `to` (días argentinos, hasta 366), por categoría, por período (`groupBy`: día, semana o mes) y por caja. No cuentan las transferencias entre cajas, el ajuste de apertura de una sesión ni los movimientos anulados con su contraasiento (los dos se excluyen); el sobrante y el faltante de un arqueo sí. Los períodos sin movimientos vienen en cero.',
  })
  @ApiOkResponse({ type: IncomeStatementDto })
  @ApiBadRequestResponse({
    description: 'Fechas inválidas, rango invertido o de más de 366 días',
  })
  @ApiNotFoundResponse({
    description: 'La caja no existe o es de otra distribuidora',
  })
  incomeStatement(
    @Query() query: QueryIncomeStatementDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<IncomeStatementDto> {
    return this.resultado.consultar(distributorId, query);
  }
}
