import { Body, Controller, Get, Put } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
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
  ScheduledTasksConfigResponseDto,
} from './dto/scheduled-tasks-config.dto';
import { DispatchSettingsService } from './dispatch-settings.service';
import { ScheduledTasksSettingsService } from './scheduled-tasks-settings.service';

const FALTA_DISTRIBUIDORA =
  'Super admin sin X-Distributor ("Falta la distribuidora: enviá el header X-Distributor (slug o id)") o cuerpo fuera de los límites (detalle por campo)';

/**
 * Parámetros por distribuidora de los procesos configurables: el despacho de
 * pedidos (CU-171) y la frecuencia de las tareas programadas (CU-173). El admin
 * de empresa opera sobre la suya; el super admin elige con `X-Distributor`.
 */
@ApiTags('Configuración · Parámetros por distribuidora')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('module-config')
export class ModuleConfigController {
  constructor(
    private readonly dispatch: DispatchSettingsService,
    private readonly tasks: ScheduledTasksSettingsService,
  ) {}

  @Get('dispatch')
  @ApiOperation({
    summary: 'Parámetros del despacho de la distribuidora',
    description:
      'Pasos de radio (km) y ventana de aceptación de la oferta (s). Si la distribuidora no configuró nada, devuelve los valores por omisión (`isDefault: true`).',
  })
  @ApiOkResponse({ type: DispatchConfigResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  getDispatch(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<DispatchConfigResponseDto> {
    return this.dispatch.vigentes(distributorId);
  }

  @Put('dispatch')
  @ApiOperation({
    summary: 'Cambiar los parámetros del despacho',
    description:
      'Reemplaza la configuración. De 1 a 8 pasos de radio, cada uno entre 1 y 100 km y estrictamente mayor que el anterior; ventana entre 10 y 300 s. Rige para las ofertas que se creen desde ese momento (las ya enviadas conservan su vencimiento); en otras instancias del servidor, como máximo un minuto después.',
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

  @Get('scheduled_tasks')
  @ApiOperation({
    summary: 'Frecuencia de las tareas programadas de la distribuidora',
    description:
      'Intervalo (s) de cada tarea y hora del aviso de vencimientos de flota. Sin configuración, los valores por omisión (los vigentes antes de CU-173).',
  })
  @ApiOkResponse({ type: ScheduledTasksConfigResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  getScheduledTasks(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<ScheduledTasksConfigResponseDto> {
    return this.tasks.vigentes(distributorId);
  }

  @Put('scheduled_tasks')
  @ApiOperation({
    summary: 'Cambiar la frecuencia de las tareas programadas',
    description:
      'Reemplaza la configuración. Cada intervalo es un múltiplo entero del ciclo de base de su tarea (15 s, 5 min, 1 h, 30 min) y de hasta 24 h; la hora del aviso de flota va de 0 a 23. Al guardar se borran las marcas de última ejecución de la distribuidora: los intervalos nuevos rigen desde el ciclo siguiente.',
  })
  @ApiOkResponse({ type: ScheduledTasksConfigResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  putScheduledTasks(
    @Body() dto: ScheduledTasksConfigDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<ScheduledTasksConfigResponseDto> {
    return this.tasks.guardar(distributorId, dto, actorUserId);
  }
}
