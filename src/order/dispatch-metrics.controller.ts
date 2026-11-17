import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { Permiso } from '../common/decorators/permiso.decorator';
import { DispatchMetricsService } from './application/dispatch-metrics.service';
import { DispatchMetricsResponseDto } from './dto/dispatch-metrics-response.dto';

/** Métricas del despacho automático (M1) de la distribuidora (API v2). */
@ApiTags('Despacho · Métricas (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'dispatch', version: '2' })
export class DispatchMetricsController {
  constructor(private readonly metricas: DispatchMetricsService) {}

  @Permiso('pedidos.ver')
  @Get('metrics')
  @ApiOperation({
    summary: 'Cómo viene el despacho',
    description:
      'Pedidos despachados, ofertas por pedido, porcentaje de ofertas aceptadas, rechazadas y vencidas (sobre las ya resueltas), tiempo de respuesta del chofer y tiempo hasta asignar (mediana y p90, en segundos), pedidos que se quedaron sin chofer y los 5 choferes con mejor tasa de aceptación. El tiempo de respuesta sólo cuenta ofertas con respuesta registrada: las anteriores a esta función no la tienen. Por omisión, los últimos 30 días; el período puede ser de hasta 366 días. El super admin tiene que mandar `X-Distributor`.',
  })
  @ApiQuery({ name: 'from', required: false, example: '2026-11-01' })
  @ApiQuery({ name: 'to', required: false, example: '2026-11-17' })
  @ApiOkResponse({ type: DispatchMetricsResponseDto })
  @ApiBadRequestResponse({
    description:
      'Fecha inválida, `from` posterior a `to`, período de más de 366 días o falta `X-Distributor` (super admin)',
  })
  obtener(
    @CurrentDistributor({ required: true }) distributorId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<DispatchMetricsResponseDto> {
    return this.metricas.obtener(distributorId, from, to);
  }
}
