import { Body, Controller, Get, Param, Put, Version } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  DispatchConfigDto,
  DispatchConfigResponseDto,
} from './dto/dispatch-config.dto';
import {
  ScheduledTasksConfigDto,
  EmpresaScheduledTasksDto,
  ScheduledTasksConfigResponseDto,
} from './dto/scheduled-tasks-config.dto';
import { ProcessConfigResponseDto } from './dto/process-config.dto';
import { PROCESOS_AUTOMATICOS } from './process-config';
import { ProcessConfigService } from './process-config.service';
import { DispatchSettingsService } from './dispatch-settings.service';
import { ScheduledTasksSettingsService } from './scheduled-tasks-settings.service';
import { Permiso } from '../common/decorators/permiso.decorator';
import { Documenta403DeModuloDinamico } from '../platform/access/requiere-modulo.decorator';

const FALTA_DISTRIBUIDORA =
  'Super admin sin X-Distributor ("Falta la distribuidora: enviá el header X-Distributor (slug o id)") o cuerpo fuera de los límites (detalle por campo)';

/**
 * Parámetros por distribuidora de los procesos configurables: el despacho de
 * pedidos (CU-171) y las tareas programadas (CU-173). La ruta v1 conserva sus
 * frecuencias históricas; la escritura nueva de plataforma vive en v2. El admin
 * de empresa opera sobre la suya; el super admin la lee en modo soporte.
 */
@ApiTags('Configuración · Parámetros por distribuidora')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('module-config')
export class ModuleConfigController {
  constructor(
    private readonly dispatch: DispatchSettingsService,
    private readonly tasks: ScheduledTasksSettingsService,
    private readonly processes: ProcessConfigService,
  ) {}

  @Permiso('configuracion.ver')
  @Get('dispatch')
  @ApiOperation({
    summary: 'Parámetros del despacho de la distribuidora',
    description:
      'Pasos de radio (km), ventana de aceptación de la oferta (s), radio en metros al destino para los choferes por terminar su entrega (CU-013) y minutos que un pedido pendiente espera chofer antes de que el sistema lo cancele. Si la distribuidora no configuró nada, devuelve los valores por omisión (`isDefault: true`).',
  })
  @ApiOkResponse({ type: DispatchConfigResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  getDispatch(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<DispatchConfigResponseDto> {
    return this.dispatch.vigentes(distributorId);
  }

  @Permiso('configuracion.gestionar')
  @Put('dispatch')
  @ApiOperation({
    summary: 'Cambiar los parámetros del despacho',
    description:
      'Reemplaza la configuración. De 1 a 8 pasos de radio, cada uno entre 1 y 100 km y estrictamente mayor que el anterior; ventana entre 10 y 300 s; radio de choferes por terminar entre 0 y 5000 m, entero (0 lo apaga: sólo se ofrece a choferes sin pedido en curso); minutos sin chofer antes de cancelar el pedido entre 1 y 1440, entero (por omisión 120). Rige para las ofertas que se creen desde ese momento (las ya enviadas conservan su vencimiento); en otras instancias del servidor, como máximo un minuto después. El plazo sin chofer se aplica en el próximo barrido del despacho a todos los pedidos que esperan, con el valor vigente.',
  })
  @ApiOkResponse({ type: DispatchConfigResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  putDispatch(
    @Body() dto: DispatchConfigDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<DispatchConfigResponseDto> {
    return this.dispatch.guardar(distributorId, dto, actorUserId);
  }

  @Permiso('configuracion.ver')
  @Get('scheduled_tasks')
  @ApiOperation({
    summary: 'Frecuencia de las tareas programadas de la distribuidora',
    description:
      'Ruta v1 congelada: intervalos (s) de cada tarea y hora del aviso de vencimientos de flota. Sin configuración, los valores por omisión (los vigentes antes de CU-173). Las frecuencias están deprecadas en v1; la escritura nueva de plataforma vive en v2.',
  })
  @ApiOkResponse({ type: ScheduledTasksConfigResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  getScheduledTasks(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<ScheduledTasksConfigResponseDto> {
    return this.tasks.vigentes(distributorId);
  }

  @Permiso('configuracion.gestionar')
  @Put('scheduled_tasks')
  @ApiOperation({
    summary: 'Cambiar las tareas programadas de la distribuidora',
    description:
      'Ruta v1 congelada: conserva el contrato histórico. `fleetAlertHour` sigue siendo de la distribuidora. Las cuatro frecuencias se aceptan sólo si coinciden con las vigentes (para clientes viejos que reenvían el cuerpo completo); si difieren responde 400 con `SCHEDULED_TASKS_PLATFORM_OWNED`, porque las fija la plataforma.',
  })
  @ApiOkResponse({ type: ScheduledTasksConfigResponseDto })
  @ApiBadRequestResponse({
    description: `Intervalo u hora inválidos, ${FALTA_DISTRIBUIDORA}, o una frecuencia distinta de la vigente (code: SCHEDULED_TASKS_PLATFORM_OWNED).`,
  })
  putScheduledTasks(
    @Body() dto: ScheduledTasksConfigDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<ScheduledTasksConfigResponseDto> {
    return this.tasks.guardarDeLaEmpresaV1(distributorId, dto, actorUserId);
  }

  /** La escritura nueva del panel de empresa: sólo su hora, por merge. */
  @Version('2')
  @Permiso('configuracion.gestionar')
  @Put('scheduled_tasks')
  @ApiOperation({
    summary: 'Cambiar la hora del aviso de flota de la distribuidora',
    description:
      'Ruta v2 para el panel de empresa. Actualiza sólo `fleetAlertHour` y conserva las frecuencias que administra la plataforma en `PUT /v2/platform/companies/{id}/scheduled-tasks`.',
  })
  @ApiOkResponse({ type: ScheduledTasksConfigResponseDto })
  @ApiBadRequestResponse({
    description: `Hora inválida, frecuencia no permitida o ${FALTA_DISTRIBUIDORA}`,
  })
  putScheduledTasksV2(
    @Body() dto: EmpresaScheduledTasksDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<ScheduledTasksConfigResponseDto> {
    return this.tasks.guardarHoraDeLaEmpresa(distributorId, dto, actorUserId);
  }

  // Las rutas genéricas van DESPUÉS de las fijas (dispatch, scheduled_tasks): Nest
  // resuelve en orden de declaración.
  @Permiso('configuracion.ver')
  @Get('processes')
  @ApiOperation({
    summary:
      'Los procesos automáticos configurables con sus parámetros vigentes',
    description:
      'Los procesos de CU-172 (planificador de flota, recompra, agrupación por recorrido y recuperación de envases), cada uno con su esquema (rango y valor por omisión de cada parámetro) y los valores vigentes. El despacho, las tareas programadas y el despacho express tienen su propia ruta.',
  })
  @ApiOkResponse({ type: [ProcessConfigResponseDto] })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  getProcesses(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<ProcessConfigResponseDto[]> {
    return this.processes.todos(distributorId);
  }

  @Documenta403DeModuloDinamico()
  @Permiso('configuracion.ver')
  @Get(':process')
  @ApiOperation({
    summary: 'Parámetros vigentes de un proceso automático',
    description:
      'Los parámetros de la distribuidora o, si no configuró ninguno, los de omisión (`isDefault: true`).',
  })
  @ApiParam({ name: 'process', enum: PROCESOS_AUTOMATICOS })
  @ApiOkResponse({ type: ProcessConfigResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  @ApiNotFoundResponse({
    description: 'El proceso no es uno de los cinco configurables',
  })
  async getProcess(
    @Param('process') process: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<ProcessConfigResponseDto> {
    return this.processes.vigentes(
      distributorId,
      await this.processes.procesoHabilitado(process, distributorId),
    );
  }

  @Documenta403DeModuloDinamico()
  @Permiso('configuracion.gestionar')
  @Put(':process')
  @ApiOperation({
    summary: 'Cambiar los parámetros de un proceso automático',
    description:
      'Reemplaza la configuración: se guarda sólo lo que viene y lo demás toma su valor por omisión (`{}` restablece los valores por omisión, igual que en el despacho y las tareas programadas). Cada proceso valida con su propio esquema (`GET /module-config/processes`): un parámetro desconocido, de otro tipo o fuera de rango responde 400 con el campo. Los leen los procesos automáticos de cada módulo (M2 planificador de flota, M3 recompra, M4 recorridos, M5 recupero de envases): un cambio rige desde la siguiente ejecución y las que están en curso no se interrumpen. M3, M4 y M5 vienen apagados por omisión (`enabled` = 0) hasta que el administrador los enciende.',
  })
  @ApiParam({ name: 'process', enum: PROCESOS_AUTOMATICOS })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: { type: 'number' },
      example: { anticipationDays: 5, invitationTtlHours: 48 },
    },
  })
  @ApiOkResponse({ type: ProcessConfigResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  @ApiNotFoundResponse({
    description: 'El proceso no es uno de los cinco configurables',
  })
  async putProcess(
    @Param('process') process: string,
    @Body() body: Record<string, unknown>,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<ProcessConfigResponseDto> {
    return this.processes.guardar(
      distributorId,
      await this.processes.procesoHabilitado(process, distributorId),
      body,
      actorUserId,
    );
  }
}
