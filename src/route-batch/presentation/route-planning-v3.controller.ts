import { Body, Controller, Get, Patch } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permiso } from '../../common/decorators/permiso.decorator';
import { ProcessConfigResponseDto } from '../../distributor/dto/process-config.dto';
import { ConfigurableProcess } from '../../distributor/entities/module-config.entity';
import { ProcessConfigService } from '../../distributor/process-config.service';
import { RequiereModulo } from '../../platform/access/requiere-modulo.decorator';
import {
  MODO_COMO_NUMERO,
  ServiceTimeService,
} from '../application/service-time.service';
import { PatchRoutePlanningSettingsV3Dto } from './dto/route-sheet-request.dto';
import { ServiceTimeDto } from './dto/route-sheet-response.dto';

const FALTA_DISTRIBUIDORA =
  'Falta la distribuidora (super admin sin X-Distributor)';

/**
 * Hoja de ruta, API v3: el tiempo de atención aprendido (M4) y los parámetros
 * con su modo. La v2 de los parámetros no cambia.
 */
@RequiereModulo('route_planning')
@ApiTags('Route plans (v3)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'route-planning', version: '3' })
export class RoutePlanningV3Controller {
  constructor(
    private readonly serviceTime: ServiceTimeService,
    private readonly processConfig: ProcessConfigService,
  ) {}

  @Permiso('despacho.gestionar')
  @Get('service-time')
  @ApiOperation({
    summary: 'Tiempo de atención por parada: sugerido y vigente',
    description:
      'La mediana de «Llegué» a la entrega confirmada de los últimos 30 días (calculada cada noche), con el fijo que configuró el administrador, el modo elegido y con cuántos minutos se planifica hoy. Sólo lectura.',
  })
  @ApiOkResponse({ type: ServiceTimeDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  async estado(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<ServiceTimeDto> {
    const e = await this.serviceTime.estado(distributorId);
    return { ...e, computedAt: e.computedAt?.toISOString() ?? null };
  }

  @Permiso('despacho.gestionar')
  @Patch('settings')
  @ApiOperation({
    summary: 'Cambiar parámetros de la hoja de ruta (con el modo de servicio)',
    description:
      'Cambia sólo los que vienen; el resto conserva su valor. `serviceMinutesMode` elige `fixed` o `learned`.',
  })
  @ApiOkResponse({ type: ProcessConfigResponseDto })
  @ApiBadRequestResponse({
    description:
      'Valor fuera de rango, modo inválido (`serviceMinutesMode`) o falta la distribuidora',
  })
  async patch(
    @Body() dto: PatchRoutePlanningSettingsV3Dto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<ProcessConfigResponseDto> {
    const { serviceMinutesMode, ...resto } = dto;
    const actuales = await this.processConfig.obtener(
      distributorId,
      ConfigurableProcess.ROUTE_PLANNING,
    );
    const nuevos: Record<string, number> = { ...actuales };
    for (const [k, v] of Object.entries(resto)) {
      if (typeof v === 'number') nuevos[k] = v;
    }
    if (serviceMinutesMode !== undefined) {
      nuevos.serviceMinutesMode = MODO_COMO_NUMERO[serviceMinutesMode];
    }
    return this.processConfig.guardar(
      distributorId,
      ConfigurableProcess.ROUTE_PLANNING,
      nuevos,
      userId,
    );
  }
}
