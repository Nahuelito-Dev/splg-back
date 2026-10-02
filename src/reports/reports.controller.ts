import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  EvolucionDeVentasDto,
  VentasPorChoferDto,
  VentasPorMedioDePagoDto,
  VentasPorProductoDto,
} from './dto/report-response.dto';
import { ReportsService } from './reports.service';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import {
  Granularidad,
  ReportRangeQueryDto,
  ReportEvolutionQueryDto,
} from './dto/report-range-query.dto';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';

@ApiTags('Reports')
@ApiBearerAuth()
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  private parseDates(
    from?: string,
    to?: string,
  ): { startDate: Date; endDate: Date } {
    const startDate = from
      ? new Date(from)
      : new Date(new Date().setHours(0, 0, 0, 0)); // Default today 00:00
    const endDate = to ? new Date(to) : new Date(); // Default now

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      throw new BadRequestException('Invalid date format (YYYY-MM-DD)');
    }

    return { startDate, endDate };
  }

  @Get('sales-by-driver')
  @ApiOperation({ summary: 'Ventas por Repartidor' })
  @ApiOkResponse({ type: VentasPorChoferDto, isArray: true })
  @ApiBadRequestResponse({ description: 'Fecha con formato inválido' })
  async getSalesByDriver(
    @Query() rango: ReportRangeQueryDto,
    @CurrentDistributor() distributorId?: string | null,
  ): Promise<VentasPorChoferDto[]> {
    const { startDate, endDate } = this.parseDates(rango.from, rango.to);
    // Admin de distribuidora → sólo sus ventas; super_admin sin header → todas.
    return this.reportsService.getSalesByDriver(
      startDate,
      endDate,
      distributorId,
    );
  }

  @Get('sales-by-product')
  @ApiOperation({ summary: 'Ventas por Producto' })
  @ApiOkResponse({ type: VentasPorProductoDto, isArray: true })
  @ApiBadRequestResponse({ description: 'Fecha con formato inválido' })
  async getSalesByProduct(
    @Query() rango: ReportRangeQueryDto,
    @CurrentDistributor() distributorId?: string | null,
  ): Promise<VentasPorProductoDto[]> {
    const { startDate, endDate } = this.parseDates(rango.from, rango.to);
    return this.reportsService.getSalesByProduct(
      startDate,
      endDate,
      distributorId,
    );
  }

  @Get('sales-by-payment')
  @ApiOperation({ summary: 'Ventas por Método de Pago' })
  @ApiOkResponse({ type: VentasPorMedioDePagoDto, isArray: true })
  @ApiBadRequestResponse({ description: 'Fecha con formato inválido' })
  async getSalesByPayment(
    @Query() rango: ReportRangeQueryDto,
    @CurrentDistributor() distributorId?: string | null,
  ): Promise<VentasPorMedioDePagoDto[]> {
    const { startDate, endDate } = this.parseDates(rango.from, rango.to);
    return this.reportsService.getSalesByPaymentMethod(
      startDate,
      endDate,
      distributorId,
    );
  }

  @Get('sales-evolution')
  @ApiOperation({ summary: 'Evolución de ventas por período (día/semana/mes)' })
  @ApiOkResponse({ type: EvolucionDeVentasDto, isArray: true })
  @ApiBadRequestResponse({ description: 'Fecha con formato inválido' })
  async getSalesEvolution(
    @Query() rango: ReportEvolutionQueryDto,
    @CurrentDistributor() distributorId?: string | null,
  ): Promise<EvolucionDeVentasDto[]> {
    const { startDate, endDate } = this.parseDates(rango.from, rango.to);
    return this.reportsService.getSalesEvolution(
      startDate,
      endDate,
      this.aGranularidadSql(rango.granularity),
      distributorId,
    );
  }

  /** `Granularidad` ya usa el mismo vocabulario que `date_trunc` de Postgres
   * ('day' | 'week' | 'month'); esto sólo fija el default (sin query, día). */
  private aGranularidadSql(
    granularity?: Granularidad,
  ): 'day' | 'week' | 'month' {
    switch (granularity) {
      case Granularidad.SEMANA:
        return 'week';
      case Granularidad.MES:
        return 'month';
      default:
        return 'day';
    }
  }
}
