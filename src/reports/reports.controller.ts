import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  CobrosDeEfectivoDto,
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
import { rangoDelInforme } from './rango-del-informe';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { Permiso } from '../common/decorators/permiso.decorator';

@ApiTags('Reports')
@ApiBearerAuth()
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Permiso('reportes.ver')
  @Get('sales-by-driver')
  @ApiOperation({
    summary: 'Ventas por Repartidor',
    description:
      'Días en hora argentina (America/Argentina/Buenos_Aires); `to` es inclusivo. Cuenta pedidos entregados en el rango, por fecha de entrega (el listado de pedidos filtra por fecha de creación). Suma el total del pedido (con recargos) de los pedidos entregados. Cuenta sólo lo COBRADO: `paymentStatus: paid` (cualquier medio); el efectivo pendiente de confirmar, las transferencias sin confirmar o no recibidas, los impagos y las pérdidas no suman (ver `GET /reports/collections`).',
  })
  @ApiOkResponse({ type: VentasPorChoferDto, isArray: true })
  @ApiBadRequestResponse({
    description: 'Fecha con formato inválido o from posterior a to',
  })
  async getSalesByDriver(
    @Query() rango: ReportRangeQueryDto,
    @CurrentDistributor() distributorId?: string | null,
  ): Promise<VentasPorChoferDto[]> {
    const { startDate, endDate } = rangoDelInforme(rango.from, rango.to);
    // Admin de distribuidora → sólo sus ventas; super_admin sin header → todas.
    return this.reportsService.getSalesByDriver(
      startDate,
      endDate,
      distributorId,
    );
  }

  @Permiso('reportes.ver')
  @Get('sales-by-product')
  @ApiOperation({
    summary: 'Ventas por Producto',
    description:
      'Días en hora argentina (America/Argentina/Buenos_Aires); `to` es inclusivo. Cuenta pedidos entregados en el rango, por fecha de entrega (el listado de pedidos filtra por fecha de creación). Suma los subtotales de los renglones (sin recargos): por eso el total puede ser menor al de sales-by-driver/sales-by-payment, que suman el total del pedido. Cuenta sólo lo COBRADO: `paymentStatus: paid` (cualquier medio); el efectivo pendiente de confirmar, las transferencias sin confirmar o no recibidas, los impagos y las pérdidas no suman (ver `GET /reports/collections`).',
  })
  @ApiOkResponse({ type: VentasPorProductoDto, isArray: true })
  @ApiBadRequestResponse({
    description: 'Fecha con formato inválido o from posterior a to',
  })
  async getSalesByProduct(
    @Query() rango: ReportRangeQueryDto,
    @CurrentDistributor() distributorId?: string | null,
  ): Promise<VentasPorProductoDto[]> {
    const { startDate, endDate } = rangoDelInforme(rango.from, rango.to);
    return this.reportsService.getSalesByProduct(
      startDate,
      endDate,
      distributorId,
    );
  }

  @Permiso('reportes.ver')
  @Get('sales-by-payment')
  @ApiOperation({
    summary: 'Ventas por Método de Pago',
    description:
      'Días en hora argentina (America/Argentina/Buenos_Aires); `to` es inclusivo. Cuenta pedidos entregados en el rango, por fecha de entrega (el listado de pedidos filtra por fecha de creación). Suma el total del pedido (con recargos) de los pedidos entregados. Cuenta sólo lo COBRADO: `paymentStatus: paid` (cualquier medio); el efectivo pendiente de confirmar, las transferencias sin confirmar o no recibidas, los impagos y las pérdidas no suman (ver `GET /reports/collections`).',
  })
  @ApiOkResponse({ type: VentasPorMedioDePagoDto, isArray: true })
  @ApiBadRequestResponse({
    description: 'Fecha con formato inválido o from posterior a to',
  })
  async getSalesByPayment(
    @Query() rango: ReportRangeQueryDto,
    @CurrentDistributor() distributorId?: string | null,
  ): Promise<VentasPorMedioDePagoDto[]> {
    const { startDate, endDate } = rangoDelInforme(rango.from, rango.to);
    return this.reportsService.getSalesByPaymentMethod(
      startDate,
      endDate,
      distributorId,
    );
  }

  @Permiso('reportes.ver')
  @Get('sales-evolution')
  @ApiOperation({
    summary: 'Evolución de ventas por período (día/semana/mes)',
    description:
      'Días en hora argentina (America/Argentina/Buenos_Aires); `to` es inclusivo. Cuenta pedidos entregados en el rango, por fecha de entrega (el listado de pedidos filtra por fecha de creación). Los períodos (día, semana ISO lunes a domingo, mes) se agrupan en hora argentina y `period` es el instante en que arranca cada uno. Suma el total del pedido (con recargos). Cuenta sólo lo COBRADO: `paymentStatus: paid` (cualquier medio); el efectivo pendiente de confirmar, las transferencias sin confirmar o no recibidas, los impagos y las pérdidas no suman (ver `GET /reports/collections`).',
  })
  @ApiOkResponse({ type: EvolucionDeVentasDto, isArray: true })
  @ApiBadRequestResponse({
    description: 'Fecha con formato inválido o from posterior a to',
  })
  async getSalesEvolution(
    @Query() rango: ReportEvolutionQueryDto,
    @CurrentDistributor() distributorId?: string | null,
  ): Promise<EvolucionDeVentasDto[]> {
    const { startDate, endDate } = rangoDelInforme(rango.from, rango.to);
    return this.reportsService.getSalesEvolution(
      startDate,
      endDate,
      this.aGranularidadSql(rango.granularity),
      distributorId,
    );
  }

  @Permiso('reportes.ver')
  @Get('collections')
  @ApiOperation({
    summary: 'Cobros fuera de las ventas',
    description:
      'Días en hora argentina; `to` es inclusivo; por fecha de entrega. Cifras que NO suman a las ventas: ' +
      'efectivo entregado pendiente de confirmar por el chofer (`pendingCash`), impagos sin resolver (`unpaid`, por lo que falta cobrar: el total menos la seña ya paga) ' +
      'y pérdidas (`writtenOff`); y, sólo de pedidos viejos, transferencias que quedaron sin confirmar (`pendingTransfer`) ' +
      'o marcadas como no recibidas (`notReceivedTransfer`).',
  })
  @ApiOkResponse({ type: CobrosDeEfectivoDto })
  @ApiBadRequestResponse({
    description: 'Fecha con formato inválido o from posterior a to',
  })
  async getCollections(
    @Query() rango: ReportRangeQueryDto,
    @CurrentDistributor() distributorId?: string | null,
  ): Promise<CobrosDeEfectivoDto> {
    const { startDate, endDate } = rangoDelInforme(rango.from, rango.to);
    return this.reportsService.getCollections(
      startDate,
      endDate,
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
