import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { periodoAnterior } from './domain/totales-de-ventas';
import {
  ReportRangeQueryDto,
  ReportSummaryQueryDto,
} from './dto/report-range-query.dto';
import {
  ComparativoDeVentasDto,
  ImpagosDto,
  TotalDelDiaDto,
  VentasPorChoferV2Dto,
  VentasPorMedioDePagoV2Dto,
  VentasPorProductoV2Dto,
} from './dto/report-v2.dto';
import { rangoDelInforme } from './rango-del-informe';
import { ReportsService } from './reports.service';

const NOTA_VENTAS =
  'Mismos criterios que la v1 (días en hora argentina, `to` inclusivo, sólo lo COBRADO). ';

/**
 * Informes con sus totales calculados por el back (API v2): el panel muestra las
 * filas y los totales tal como vienen, sin sumar ni ordenar plata.
 */
@ApiTags('Reports (v2)')
@ApiBearerAuth()
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'reports', version: '2' })
export class ReportsV2Controller {
  constructor(private readonly reports: ReportsService) {}

  @Get('sales-by-driver')
  @ApiOperation({
    summary: 'Ventas por repartidor, con totales',
    description:
      NOTA_VENTAS +
      '`rows` viene de mayor a menor venta (el ranking) y `totals` suma todas las filas.',
  })
  @ApiOkResponse({ type: VentasPorChoferV2Dto })
  @ApiBadRequestResponse({
    description: 'Fecha con formato inválido o from posterior a to',
  })
  ventasPorChofer(
    @Query() rango: ReportRangeQueryDto,
    @CurrentDistributor() distributorId?: string | null,
  ): Promise<VentasPorChoferV2Dto> {
    const { startDate, endDate } = rangoDelInforme(rango.from, rango.to);
    return this.reports.getSalesByDriverConTotales(
      startDate,
      endDate,
      distributorId,
    );
  }

  @Get('sales-by-payment')
  @ApiOperation({
    summary: 'Ventas por medio de pago, con totales',
    description:
      NOTA_VENTAS +
      '`rows` viene de mayor a menor venta y `totals` suma todas las filas.',
  })
  @ApiOkResponse({ type: VentasPorMedioDePagoV2Dto })
  @ApiBadRequestResponse({
    description: 'Fecha con formato inválido o from posterior a to',
  })
  ventasPorMedioDePago(
    @Query() rango: ReportRangeQueryDto,
    @CurrentDistributor() distributorId?: string | null,
  ): Promise<VentasPorMedioDePagoV2Dto> {
    const { startDate, endDate } = rangoDelInforme(rango.from, rango.to);
    return this.reports.getSalesByPaymentMethodConTotales(
      startDate,
      endDate,
      distributorId,
    );
  }

  @Get('sales-by-product')
  @ApiOperation({
    summary: 'Ventas por producto, con totales',
    description:
      NOTA_VENTAS +
      'Suma los subtotales de los renglones (sin recargos). `rows` viene de mayor a menor venta y `totals` suma todas las filas.',
  })
  @ApiOkResponse({ type: VentasPorProductoV2Dto })
  @ApiBadRequestResponse({
    description: 'Fecha con formato inválido o from posterior a to',
  })
  ventasPorProducto(
    @Query() rango: ReportRangeQueryDto,
    @CurrentDistributor() distributorId?: string | null,
  ): Promise<VentasPorProductoV2Dto> {
    const { startDate, endDate } = rangoDelInforme(rango.from, rango.to);
    return this.reports.getSalesByProductConTotales(
      startDate,
      endDate,
      distributorId,
    );
  }

  @Get('sales-summary')
  @ApiOperation({
    summary: 'Ventas, pedidos y ticket promedio de un período y del anterior',
    description:
      NOTA_VENTAS +
      '`previous` es el período inmediato anterior de la misma cantidad de días (con `currentRange` y `previousRange` los días exactos); con `compare=false` no se calcula y vienen en null. El ticket promedio es ventas / pedidos a 2 decimales (0 sin pedidos).',
  })
  @ApiOkResponse({ type: ComparativoDeVentasDto })
  @ApiBadRequestResponse({
    description: 'Fecha con formato inválido o from posterior a to',
  })
  async resumenDeVentas(
    @Query() rango: ReportSummaryQueryDto,
    @CurrentDistributor() distributorId?: string | null,
  ): Promise<ComparativoDeVentasDto> {
    const actual = rangoDelInforme(rango.from, rango.to);
    const current = await this.reports.getSalesSummary(
      actual.startDate,
      actual.endDate,
      distributorId,
    );
    const currentRange = { from: actual.from, to: actual.to };
    if (rango.compare === false) {
      return { current, previous: null, currentRange, previousRange: null };
    }
    const previo = periodoAnterior(actual.from, actual.to);
    const anterior = rangoDelInforme(previo.desde, previo.hasta);
    return {
      current,
      previous: await this.reports.getSalesSummary(
        anterior.startDate,
        anterior.endDate,
        distributorId,
      ),
      currentRange,
      previousRange: { from: anterior.from, to: anterior.to },
    };
  }

  @Get('unpaid-total')
  @ApiOperation({
    summary: 'Pedidos impagos y lo adeudado en total',
    description:
      'Todos los pedidos con `paymentStatus: unpaid` de la distribuidora (sin acotar por fecha), los mismos que lista `GET /orders?paymentStatus=unpaid`: cantidad y lo que falta cobrar de ellos (el total menos la seña ya paga).',
  })
  @ApiOkResponse({ type: ImpagosDto })
  unpaidTotal(
    @CurrentDistributor() distributorId?: string | null,
  ): Promise<ImpagosDto> {
    return this.reports.getUnpaidTotal(distributorId);
  }

  @Get('delivery/me/daily-totals')
  @Auth(RoleType.DELIVERY)
  @ApiOperation({
    summary: 'Lo entregado por el chofer, día por día',
    description:
      'Por día en hora argentina, los pedidos que el chofer autenticado entregó y lo que había que cobrar de ellos (total menos la seña ya paga). Sólo días con entregas, del más reciente al más antiguo. Sin `from`/`to`, hoy.',
  })
  @ApiOkResponse({ type: TotalDelDiaDto, isArray: true })
  @ApiBadRequestResponse({
    description: 'Fecha con formato inválido o from posterior a to',
  })
  totalesDelChofer(
    @Query() rango: ReportRangeQueryDto,
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<TotalDelDiaDto[]> {
    const { startDate, endDate } = rangoDelInforme(rango.from, rango.to);
    return this.reports.getDriverDailyTotals(
      userId,
      startDate,
      endDate,
      distributorId,
    );
  }
}
