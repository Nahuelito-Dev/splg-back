import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { ProcessConfigResponseDto } from '../../distributor/dto/process-config.dto';
import {
  CancelPlanningCaseDto,
  ConfirmPlanningCaseDto,
  ForceWindowDto,
  PatchPlannerSettingsDto,
  QueryPlannerForecastDto,
  QueryPlanningCasesDto,
} from './dto/planner-request.dto';
import {
  PlannerForecastResponseDto,
  PlannerRunResponseDto,
  PlanningCaseDetailResponseDto,
  PlanningCasePageDto,
} from './dto/planner-response.dto';
import { MaintenancePlannerMapper } from './maintenance-planner.mapper';
import { MaintenancePlannerService } from './maintenance-planner.service';

const FALTA_DISTRIBUIDORA =
  'Super admin sin X-Distributor ("Falta la distribuidora: enviá el header X-Distributor (slug o id)")';

/**
 * Planificador de taller de la flota (CU-105, módulo inteligente M2), lado del
 * administrador: los vencimientos que el sistema proyecta, los casos con las
 * ventanas que se le proponen al chofer, y las decisiones que sólo el
 * administrador toma (confirmar el taller y el gasto, forzar una ventana,
 * re-planificar). El gasto se paga con el circuito de F27
 * (`POST /api/v2/fleet/tasks/:id/close` con `payment` o `…/pay`).
 */
@ApiTags('Fleet · Maintenance planner (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'fleet/maintenance-planner', version: '2' })
export class MaintenancePlannerController {
  constructor(private readonly planner: MaintenancePlannerService) {}

  @Get()
  @ApiOperation({
    summary: 'Casos del planificador de taller',
    description:
      'Los casos de planificación con su estado, la propuesta vigente, la última respuesta del chofer y el motivo si se escaló; más los totales por estado. `pending=true` deja los que esperan al administrador.',
  })
  @ApiOkResponse({ type: PlanningCasePageDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  async casos(
    @Query() query: QueryPlanningCasesDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<PlanningCasePageDto> {
    const [casos, total] = await this.planner.listarCasos(distributorId, {
      status: query.status,
      carId: query.carId,
      pendientesDelAdmin: query.pending,
      limit: query.limit ?? 10,
      offset: query.offset ?? 0,
    });
    return {
      data: casos.map((c) => MaintenancePlannerMapper.caso(c)),
      total,
      counts: await this.planner.contarPorEstado(distributorId),
    };
  }

  @Get('forecast')
  @ApiOperation({
    summary: 'Próximos vencimientos proyectados de la flota',
    description:
      'Por vehículo: el consumo diario estimado y de dónde sale (su historial o el promedio de su tipo), y cada tarea abierta con su vencimiento proyectado —por fecha, por kilometraje o el primero de los dos—, si entró en su anticipación y el caso de planificación si lo hay. `nextWindow` es la próxima ventana de taller del vehículo.',
  })
  @ApiOkResponse({ type: PlannerForecastResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  async forecast(
    @Query() query: QueryPlannerForecastDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<PlannerForecastResponseDto> {
    const ahora = new Date();
    const vehiculos = await this.planner.vencimientos(
      distributorId,
      { carId: query.carId },
      ahora,
    );
    return {
      vehicles: vehiculos.map((v) =>
        MaintenancePlannerMapper.vehiculo(v, ahora),
      ),
    };
  }

  @Get('settings')
  @ApiOperation({
    summary: 'Parámetros del planificador de la distribuidora',
    description:
      'Los valores vigentes con el rango y el valor por omisión de cada uno. Los mismos de `GET /module-config/fleet_planner`.',
  })
  @ApiOkResponse({ type: ProcessConfigResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  settings(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<ProcessConfigResponseDto> {
    return this.planner.parametrosVigentes(distributorId);
  }

  @Patch('settings')
  @ApiOperation({
    summary: 'Cambiar parámetros del planificador',
    description:
      'Cambia sólo los que vienen; el resto conserva su valor. El horario de taller tiene que empezar antes de terminar. Rige desde la próxima corrida.',
  })
  @ApiOkResponse({ type: ProcessConfigResponseDto })
  @ApiBadRequestResponse({
    description: 'Valor fuera de rango o inicio del taller posterior al fin',
  })
  settingsPatch(
    @Body() dto: PatchPlannerSettingsDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<ProcessConfigResponseDto> {
    return this.planner.cambiarParametros(distributorId, { ...dto }, userId);
  }

  @Post('run')
  @Idempotent()
  @ApiOperation({
    summary: 'Correr el planificador ahora',
    description:
      'Hace lo mismo que la corrida diaria, para esta distribuidora y sin esperar la hora. Es idempotente: una tarea con caso abierto o con taller programado no se vuelve a planificar.',
  })
  @ApiCreatedResponse({ type: PlannerRunResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  async run(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<PlannerRunResponseDto> {
    const r = await this.planner.ejecutar(distributorId);
    return {
      vehicles: r.vehiculos,
      predictionsUpdated: r.prediccionesActualizadas,
      proposals: r.propuestas,
      escalated: r.escaladas,
      reiterated: r.reiteradas,
      groundedVehicles: r.vehiculosFueraDeServicio,
      underObservation: r.enObservacion,
    };
  }

  @Get('cases/:id')
  @ApiOperation({
    summary: 'Ver un caso con todas sus propuestas y el cuadro de ventanas',
  })
  @ApiParam({ name: 'id', description: 'Case UUID' })
  @ApiOkResponse({ type: PlanningCaseDetailResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async caso(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<PlanningCaseDetailResponseDto> {
    return MaintenancePlannerMapper.detalle(
      await this.planner.caso(distributorId, id),
    );
  }

  @Post('cases/:id/confirm')
  @Idempotent()
  @ApiOperation({
    summary: 'Confirmar el taller de un caso',
    description:
      'Sin ventana, confirma la que acordó el chofer. Con `windowStart` y `windowEnd`, elige otra: así se resuelve un caso escalado. La tarea queda programada (`scheduledAt` = inicio de la ventana), con el proveedor y el gasto previsto si se informan, y el chofer recibe el aviso. El pago del taller se registra al cerrar la tarea (`POST /fleet/tasks/:id/close` con `payment`).',
  })
  @ApiParam({ name: 'id', description: 'Case UUID' })
  @ApiCreatedResponse({ type: PlanningCaseDetailResponseDto })
  @ApiBadRequestResponse({
    description:
      'Falta la ventana (caso sin acuerdo), ventana pasada o invertida',
  })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({
    description: 'El caso ya está resuelto o la tarea cerrada',
  })
  async confirmar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmPlanningCaseDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<PlanningCaseDetailResponseDto> {
    return MaintenancePlannerMapper.detalle(
      await this.planner.confirmar(
        distributorId,
        id,
        {
          windowStart: dto.windowStart ? new Date(dto.windowStart) : undefined,
          windowEnd: dto.windowEnd ? new Date(dto.windowEnd) : undefined,
          ignoreCoverage: dto.ignoreCoverage,
          provider: dto.provider,
          cost: dto.cost,
          notes: dto.notes,
        },
        userId,
      ),
    );
  }

  @Post('cases/:id/cancel')
  @Idempotent()
  @ApiOperation({
    summary: 'Cancelar un caso abierto',
    description:
      'Cierra el caso sin programar nada y cancela la propuesta vigente (el chofer recibe `maintenance:proposal-closed`). El planificador puede volver a abrir uno en la corrida siguiente si la tarea sigue dentro de su anticipación.',
  })
  @ApiParam({ name: 'id', description: 'Case UUID' })
  @ApiCreatedResponse({ type: PlanningCaseDetailResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({ description: 'El caso ya está resuelto' })
  async cancelar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelPlanningCaseDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<PlanningCaseDetailResponseDto> {
    return MaintenancePlannerMapper.detalle(
      await this.planner.cancelar(distributorId, id, dto.notes),
    );
  }

  @Post('tasks/:taskId/force-window')
  @Idempotent()
  @ApiOperation({
    summary: 'Fijar la ventana de una tarea sin esperar al planificador',
    description:
      'Si la tarea tiene un caso abierto lo resuelve con esta ventana (se cancela la propuesta vigente); si no, lo abre ya resuelto. Queda programada.',
  })
  @ApiParam({ name: 'taskId', description: 'Task UUID' })
  @ApiCreatedResponse({ type: PlanningCaseDetailResponseDto })
  @ApiBadRequestResponse({
    description: 'Ventana pasada o invertida, o la tarea no es de un vehículo',
  })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({ description: 'La tarea ya está cerrada' })
  async forzar(
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: ForceWindowDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<PlanningCaseDetailResponseDto> {
    return MaintenancePlannerMapper.detalle(
      await this.planner.forzar(
        distributorId,
        taskId,
        {
          windowStart: new Date(dto.windowStart),
          windowEnd: new Date(dto.windowEnd),
          ignoreCoverage: dto.ignoreCoverage,
          provider: dto.provider,
          cost: dto.cost,
          notes: dto.notes,
        },
        userId,
      ),
    );
  }

  @Post('tasks/:taskId/replan')
  @Idempotent()
  @ApiOperation({
    summary: 'Re-planificar una tarea',
    description:
      'Cancela el caso abierto de la tarea (y su propuesta vigente) y la planifica de nuevo con los datos de hoy: vuelve a ofrecerle la mejor ventana al chofer o la escala.',
  })
  @ApiParam({ name: 'taskId', description: 'Task UUID' })
  @ApiCreatedResponse({ type: PlanningCaseDetailResponseDto })
  @ApiBadRequestResponse({
    description:
      'La tarea no se resuelve en un taller o no tiene vencimiento proyectable',
  })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async replanificar(
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<PlanningCaseDetailResponseDto> {
    return MaintenancePlannerMapper.detalle(
      await this.planner.replanificar(distributorId, taskId),
    );
  }
}
