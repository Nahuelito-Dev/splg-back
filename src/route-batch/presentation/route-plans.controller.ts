import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
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
import { RoutePlanProposalService } from '../application/route-plan-proposal.service';
import { RoutePlanService } from '../application/route-plan.service';
import { RouteSheetQueryService } from '../application/route-sheet-query.service';
import {
  PatchRoutePlanningSettingsDto,
  ProposeRoutePlanDto,
  RoutePlanDateParamDto,
} from './dto/route-sheet-request.dto';
import {
  ConfirmAllResponseDto,
  LateOrderDto,
  RoutePlanDayDto,
  RoutePlanProposalDto,
} from './dto/route-sheet-response.dto';
import { RequiereModulo } from '../../platform/access/requiere-modulo.decorator';

const FALTA_DISTRIBUIDORA =
  'Falta la distribuidora (super admin sin X-Distributor) o la fecha no tiene el formato AAAA-MM-DD';

/**
 * Hoja de ruta (F34, CU-107 ampliado): la planificación de un día. El sistema
 * propone las hojas; el administrador las ajusta, confirma y cierra el día.
 */
@RequiereModulo('route_planning')
@ApiTags('Route plans (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'route-plans', version: '2' })
export class RoutePlansController {
  constructor(
    private readonly plans: RoutePlanService,
    private readonly proposal: RoutePlanProposalService,
    private readonly query: RouteSheetQueryService,
  ) {}

  @Permiso('despacho.gestionar')
  @Get(':date')
  @ApiOperation({
    summary: 'Planificación del día',
    description:
      'Estado del día (cierre, resumen de la última propuesta), las hojas vivas con sus paradas, la columna «Sin asignar» (pedidos del día sin hoja, con el motivo si no pueden ir en una) y los recursos: choferes y vehículos con su disponibilidad y la hoja confirmada que ya tengan.',
  })
  @ApiOkResponse({ type: RoutePlanDayDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  @ApiNotFoundResponse({
    description: 'El día no tiene planificación abierta (ROUTE_PLAN_NOT_FOUND)',
  })
  dia(
    @Param() p: RoutePlanDateParamDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RoutePlanDayDto> {
    return this.query.dia(distributorId, p.date);
  }

  @Permiso('despacho.gestionar')
  @Post(':date/open')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Abrir la planificación del día',
    description:
      'Idempotente: si ya estaba abierta (o propuesta, o cerrada) devuelve el día como está. Desde que se abre, los pedidos de ese día quedan retenidos para la hoja (el despacho individual no los ofrece).',
  })
  @ApiOkResponse({ type: RoutePlanDayDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  @ApiConflictResponse({ description: 'El día ya pasó (ROUTE_PLAN_DATE_PAST)' })
  async abrir(
    @Param() p: RoutePlanDateParamDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RoutePlanDayDto> {
    await this.plans.abrir(distributorId, p.date);
    return this.query.dia(distributorId, p.date);
  }

  @Permiso('despacho.gestionar')
  @Post(':date/propose')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Proponer (o re-proponer) las hojas del día',
    description:
      'Reparte los pedidos del día entre los pares chofer–vehículo libres (barrido + inserción + 2-opt/Or-opt + relocate) y crea las hojas en borrador. Re-proponer rehace sólo los borradores del sistema sin ediciones; las confirmadas y las tocadas a mano se conservan con sus pedidos. Con `dryRun: true` devuelve la propuesta sin crear nada.',
  })
  @ApiOkResponse({ type: RoutePlanProposalDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  @ApiConflictResponse({
    description:
      'Hoja de ruta apagada (ROUTE_PLANNING_DISABLED), día cerrado (ROUTE_PLAN_CLOSED), día pasado (ROUTE_PLAN_DATE_PAST) o ya se está proponiendo (ROUTE_PLAN_BUSY)',
  })
  proponer(
    @Param() p: RoutePlanDateParamDto,
    @Body() body: ProposeRoutePlanDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RoutePlanProposalDto> {
    return this.proposal.proponer(distributorId, p.date, body.dryRun === true);
  }

  @Permiso('despacho.gestionar')
  @Post(':date/close')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cerrar la planificación del día',
    description:
      'Los borradores que quedan se descartan (`dissolved`, `day_closed`) y sus pedidos vuelven al despacho del día. Las confirmadas siguen.',
  })
  @ApiOkResponse({ type: RoutePlanDayDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  @ApiNotFoundResponse({
    description: 'El día no tiene planificación (ROUTE_PLAN_NOT_FOUND)',
  })
  @ApiConflictResponse({ description: 'Ya estaba cerrada (ROUTE_PLAN_CLOSED)' })
  async cerrar(
    @Param() p: RoutePlanDateParamDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<RoutePlanDayDto> {
    await this.plans.cerrar(distributorId, p.date, userId);
    return this.query.dia(distributorId, p.date);
  }

  @Permiso('despacho.gestionar')
  @Post(':date/confirm-all')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Confirmar todos los borradores válidos del día',
    description:
      'Confirma cada borrador que cumple las reglas (sin aceptar paradas fuera de franja) y devuelve los que no pudo, con el motivo y las violaciones.',
  })
  @ApiOkResponse({ type: ConfirmAllResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  @ApiNotFoundResponse({
    description: 'El día no tiene planificación (ROUTE_PLAN_NOT_FOUND)',
  })
  confirmarTodas(
    @Param() p: RoutePlanDateParamDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<ConfirmAllResponseDto> {
    return this.plans.confirmarTodas(distributorId, p.date, userId);
  }

  @Permiso('despacho.gestionar')
  @Get(':date/late-orders')
  @ApiOperation({
    summary: 'Pedidos tardíos del día',
    description:
      'Pedidos del día creados después del cierre que no están en ninguna hoja, con la mejor inserción factible en los borradores (hoja, posición y minutos que agrega) o `null`. Con `lateOrderPolicy = 0` no hay sugerencias (`suggestion: null`: van al despacho del día). Es una sugerencia: se inserta con `POST /route-sheets/:id/stops`.',
  })
  @ApiOkResponse({ type: [LateOrderDto] })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  @ApiNotFoundResponse({
    description: 'El día no tiene planificación (ROUTE_PLAN_NOT_FOUND)',
  })
  tardios(
    @Param() p: RoutePlanDateParamDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<LateOrderDto[]> {
    return this.query.tardios(distributorId, p.date);
  }
}

/** Parámetros de la hoja de ruta (§3.5): el mismo patrón que `route-batches/settings`. */
@RequiereModulo('route_planning')
@ApiTags('Route plans (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'route-planning', version: '2' })
export class RoutePlanningSettingsController {
  constructor(private readonly processConfig: ProcessConfigService) {}

  @Permiso('despacho.gestionar')
  @Get('settings')
  @ApiOperation({
    summary: 'Parámetros de la hoja de ruta',
    description:
      'Los valores vigentes con su rango y omisión. Los mismos de `GET /module-config/route_planning`.',
  })
  @ApiOkResponse({ type: ProcessConfigResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  settings(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<ProcessConfigResponseDto> {
    return this.processConfig.vigentes(
      distributorId,
      ConfigurableProcess.ROUTE_PLANNING,
    );
  }

  @Permiso('despacho.gestionar')
  @Patch('settings')
  @ApiOperation({
    summary: 'Cambiar parámetros de la hoja de ruta',
    description: 'Cambia sólo los que vienen; el resto conserva su valor.',
  })
  @ApiOkResponse({ type: ProcessConfigResponseDto })
  @ApiBadRequestResponse({
    description: 'Valor fuera de rango o falta la distribuidora',
  })
  async patch(
    @Body() dto: PatchRoutePlanningSettingsDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<ProcessConfigResponseDto> {
    const actuales = await this.processConfig.obtener(
      distributorId,
      ConfigurableProcess.ROUTE_PLANNING,
    );
    const nuevos: Record<string, number> = { ...actuales };
    for (const [k, v] of Object.entries(dto)) {
      if (typeof v === 'number') nuevos[k] = v;
    }
    return this.processConfig.guardar(
      distributorId,
      ConfigurableProcess.ROUTE_PLANNING,
      nuevos,
      userId,
    );
  }
}
