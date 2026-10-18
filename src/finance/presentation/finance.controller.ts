import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
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
  constructor(private readonly finanzas: FinanceService) {}

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
}
