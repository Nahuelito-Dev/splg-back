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
import {
  diaArgentino,
  rangoDeDiasArgentinos,
} from '../common/utils/dias-argentina';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';

@ApiTags('Reports')
@ApiBearerAuth()
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  /**
   * `startDate` inclusive y `endDate` EXCLUSIVO: `[inicio de from, inicio del
   * día siguiente a to)` en hora argentina.
   */
  private parseDates(
    from?: string,
    to?: string,
  ): { startDate: Date; endDate: Date } {
    // Sin from/to: hoy en hora argentina. Con uno solo, el rango es ese día.
    const hoy = diaArgentino();
    const desde = from ?? to ?? hoy;
    const hasta = to ?? from ?? hoy;
    const rango = rangoDeDiasArgentinos(desde, hasta);

    if (!rango) {
      throw new BadRequestException('Invalid date format (YYYY-MM-DD)');
    }
    if (desde > hasta) {
      throw new BadRequestException('from no puede ser posterior a to');
    }

    return { startDate: rango.desde, endDate: rango.hasta };
  }

  @Get('sales-by-driver')
  @ApiOperation({
    summary: 'Ventas por Repartidor',
    description:
      'Días en hora argentina (America/Argentina/Buenos_Aires); `to` es inclusivo. Cuenta pedidos entregados en el rango, por fecha de entrega (el listado de pedidos filtra por fecha de creación). Suma el total del pedido (con recargos) de los pedidos entregados.',
  })
  @ApiOkResponse({ type: VentasPorChoferDto, isArray: true })
  @ApiBadRequestResponse({
    description: 'Fecha con formato inválido o from posterior a to',
  })
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
  @ApiOperation({
    summary: 'Ventas por Producto',
    description:
      'Días en hora argentina (America/Argentina/Buenos_Aires); `to` es inclusivo. Cuenta pedidos entregados en el rango, por fecha de entrega (el listado de pedidos filtra por fecha de creación). Suma los subtotales de los renglones (sin recargos): por eso el total puede ser menor al de sales-by-driver/sales-by-payment, que suman el total del pedido.',
  })
  @ApiOkResponse({ type: VentasPorProductoDto, isArray: true })
  @ApiBadRequestResponse({
    description: 'Fecha con formato inválido o from posterior a to',
  })
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
  @ApiOperation({
    summary: 'Ventas por Método de Pago',
    description:
      'Días en hora argentina (America/Argentina/Buenos_Aires); `to` es inclusivo. Cuenta pedidos entregados en el rango, por fecha de entrega (el listado de pedidos filtra por fecha de creación). Suma el total del pedido (con recargos) de los pedidos entregados.',
  })
  @ApiOkResponse({ type: VentasPorMedioDePagoDto, isArray: true })
  @ApiBadRequestResponse({
    description: 'Fecha con formato inválido o from posterior a to',
  })
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
  @ApiOperation({
    summary: 'Evolución de ventas por período (día/semana/mes)',
    description:
      'Días en hora argentina (America/Argentina/Buenos_Aires); `to` es inclusivo. Cuenta pedidos entregados en el rango, por fecha de entrega (el listado de pedidos filtra por fecha de creación). Los períodos (día, semana ISO lunes a domingo, mes) se agrupan en hora argentina y `period` es el instante en que arranca cada uno. Suma el total del pedido (con recargos).',
  })
  @ApiOkResponse({ type: EvolucionDeVentasDto, isArray: true })
  @ApiBadRequestResponse({
    description: 'Fecha con formato inválido o from posterior a to',
  })
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
