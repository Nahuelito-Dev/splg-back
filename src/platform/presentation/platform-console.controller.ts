import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SinDistribuidora } from '../../common/decorators/sin-distribuidora.decorator';
import { ScheduledTasksConfigResponseDto } from '../../distributor/dto/scheduled-tasks-config.dto';
import { mesDe } from '../application/periodo';
import { PlatformActivityService } from '../application/platform-activity.service';
import { PlatformCompaniesService } from '../application/platform-companies.service';
import { PlatformProcessesService } from '../application/platform-processes.service';
import { PlatformScheduleService } from '../application/platform-schedule.service';
import { PlatformUsageService } from '../application/platform-usage.service';
import {
  PlatformActivityQueryDto,
  PlatformCompaniesQueryDto,
  PlatformMonthQueryDto,
  PlatformRangeQueryDto,
  PlatformScheduledTasksDto,
} from './dto/platform-query.dto';
import {
  ActivityListResponseDto,
  CompanyDetailResponseDto,
  CompanyListResponseDto,
  DocumentReadingUsageResponseDto,
  PlatformOverviewResponseDto,
  PlatformProcessesResponseDto,
} from './dto/platform-response.dto';

const RANGO_INVALIDO =
  'Período inválido: fecha que no es AAAA-MM-DD, «desde» posterior a «hasta» o más de 366 días';
const ID_INVALIDO = 'El identificador de la empresa no es un UUID';
const NO_EXISTE = 'La empresa no existe o está dada de baja';

/**
 * Panel de plataforma (E3 del modo soporte; API v2). Sólo el administrador
 * general, con alcance `plataforma`: lo puede usar también dentro de una
 * sesión de soporte (la sesión no se lee acá: `@SinDistribuidora`). El admin de
 * una empresa recibe 403. Ninguna respuesta lleva datos personales de clientes
 * o choferes, datos bancarios ni credenciales.
 */
@ApiTags('Platform')
@Auth(RoleType.SUPER_ADMIN)
@SinDistribuidora()
@Controller({ path: 'platform', version: '2' })
export class PlatformConsoleController {
  constructor(
    private readonly companies: PlatformCompaniesService,
    private readonly processes: PlatformProcessesService,
    private readonly usage: PlatformUsageService,
    private readonly activity: PlatformActivityService,
    private readonly schedule: PlatformScheduleService,
  ) {}

  @Get('overview')
  @ApiOperation({
    summary: 'Tablero de la plataforma',
    description:
      'Empresas por estado; pedidos, ventas, facturación, choferes y clientes sumados de todas las empresas vigentes en el período (`from`/`to`, por omisión el mes en curso); uso y costo del lector del mes; alertas y fallas de los procesos; sesiones de soporte activas y pendientes. Los totales son la suma exacta de las filas de `GET /v2/platform/companies`.',
  })
  @ApiOkResponse({ type: PlatformOverviewResponseDto })
  @ApiBadRequestResponse({ description: RANGO_INVALIDO })
  overview(
    @Query() q: PlatformRangeQueryDto,
  ): Promise<PlatformOverviewResponseDto> {
    return this.companies.tablero(q.from, q.to);
  }

  @Get('companies')
  @ApiOperation({
    summary: 'Empresas con sus métricas',
    description:
      'Las empresas vigentes, primero las propias de la plataforma y después por nombre, paginadas, con las métricas del período (sin datos personales), última actividad, alertas de procesos y si tienen una sesión de soporte activa o pedidos pendientes. Filtros opcionales por `status` y `ownedByPlatform`. Esta marca indica que el administrador general la opera directo con `X-Distributor`, sin sesión de soporte.',
  })
  @ApiOkResponse({ type: CompanyListResponseDto })
  @ApiBadRequestResponse({
    description: `${RANGO_INVALIDO}, \`ownedByPlatform\` que no es true/false, estado desconocido o paginación fuera de rango (\`limit\` 1 a 100, \`offset\` ≥ 0)`,
  })
  list(@Query() q: PlatformCompaniesQueryDto): Promise<CompanyListResponseDto> {
    return this.companies.listar(q);
  }

  @Get('companies/:id')
  @ApiOperation({
    summary: 'Ficha consolidada de una empresa',
    description:
      'Datos de la empresa como cliente (sin teléfono, datos bancarios ni credenciales), métricas del período, uso del lector del mes con su tope, salud de sus procesos, sus administradores (nombre, correo, rol de personal, último ingreso: son cuentas del panel) y sus últimas 10 sesiones de soporte.',
  })
  @ApiOkResponse({ type: CompanyDetailResponseDto })
  @ApiBadRequestResponse({ description: `${ID_INVALIDO} o ${RANGO_INVALIDO}` })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  detail(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: PlatformRangeQueryDto,
  ): Promise<CompanyDetailResponseDto> {
    return this.companies.ficha(id, q.from, q.to);
  }

  @Get('companies/:id/scheduled-tasks')
  @ApiOperation({
    summary: 'Frecuencia de las tareas programadas de una empresa',
    description:
      'Las cuatro frecuencias (las fija la plataforma) y la hora del aviso de vencimientos de flota (la fija la empresa, acá sólo se lee).',
  })
  @ApiOkResponse({ type: ScheduledTasksConfigResponseDto })
  @ApiBadRequestResponse({ description: ID_INVALIDO })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  scheduledTasks(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ScheduledTasksConfigResponseDto> {
    return this.schedule.vigentes(id);
  }

  @Put('companies/:id/scheduled-tasks')
  @ApiOperation({
    summary: 'Cambiar la frecuencia de las tareas programadas de una empresa',
    description:
      'Actualiza por merge las frecuencias que llegan; la hora del aviso de flota de la empresa se conserva y no se acepta en el cuerpo. Cada intervalo es múltiplo de su ciclo de base (15 s, 5 min, 1 h, 30 min); el reintento del despacho, hasta 5 min, y los demás hasta 24 h. Los intervalos nuevos rigen desde el ciclo siguiente.',
  })
  @ApiOkResponse({ type: ScheduledTasksConfigResponseDto })
  @ApiBadRequestResponse({
    description: `${ID_INVALIDO}, intervalo que no es múltiplo de su ciclo o pasa el tope, o un campo que no es de la plataforma (\`fleetAlertHour\`)`,
  })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  saveScheduledTasks(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PlatformScheduledTasksDto,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<ScheduledTasksConfigResponseDto> {
    return this.schedule.guardar(id, dto, actorUserId);
  }

  @Get('processes')
  @ApiOperation({
    summary: 'Monitoreo agregado de los procesos automáticos',
    description:
      'Por proceso: cuántas empresas hay en cada estado de salud (`ok`, `partial`, `running`, `failed`, `late`, `stuck`, `never`), alertas actuales, corridas fallidas en 24 h y la última corrida. El detalle por empresa y el historial están en `GET /v2/process-runs/summary` y `GET /v2/process-runs`.',
  })
  @ApiOkResponse({ type: PlatformProcessesResponseDto })
  processesSummary(): Promise<PlatformProcessesResponseDto> {
    return this.processes.resumen();
  }

  @Get('document-reading-usage')
  @ApiOperation({
    summary: 'Uso y costo del lector de documentos por empresa',
    description:
      'Del mes pedido (`month`, AAAA-MM; por omisión el en curso): lecturas que llegaron al proveedor y su costo en dólares por empresa vigente, con el tope mensual y el porcentaje usado, de mayor a menor costo; más los totales.',
  })
  @ApiOkResponse({ type: DocumentReadingUsageResponseDto })
  @ApiBadRequestResponse({ description: 'Mes que no es AAAA-MM' })
  documentReadingUsage(
    @Query() q: PlatformMonthQueryDto,
  ): Promise<DocumentReadingUsageResponseDto> {
    return this.usage.porEmpresa(mesDe(q.month));
  }

  @Get('activity')
  @ApiOperation({
    summary: 'Actividad de la plataforma',
    description:
      'La auditoría propia de la plataforma, las más nuevas primero y paginada: escrituras de los administradores generales, cambios de empresas y de sesiones de soporte (también la aprobación o revocación de una empresa) e ingresos de los administradores generales. Filtros: `from`, `to` (instantes ISO 8601), `actorUserId`, `distributorId`. No incluye el detalle de los cambios ni textos de error.',
  })
  @ApiOkResponse({ type: ActivityListResponseDto })
  @ApiBadRequestResponse({
    description:
      'Filtro inválido: fecha que no es ISO 8601, «desde» posterior a «hasta», ids que no son UUID o paginación fuera de rango',
  })
  activityList(
    @Query() q: PlatformActivityQueryDto,
  ): Promise<ActivityListResponseDto> {
    return this.activity.listar(q);
  }
}
