import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../../common/constants/role-type.enum';
import { Auth } from '../../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../../common/decorators/current-distributor.decorator';
import { Permiso } from '../../../common/decorators/permiso.decorator';
import { SinDistribuidora } from '../../../common/decorators/sin-distribuidora.decorator';
import { PermisoDePlataforma } from '../../../common/permisos/catalogo-de-plataforma';
import { RequiereModulo } from '../../../platform/access/requiere-modulo.decorator';
import { ChatMetricsService } from '../../application/chat-metrics.service';
import { PlatformChatMetricsService } from '../../application/platform-chat-metrics.service';
import {
  ChatMetricsResponseDto,
  PlatformChatMetricsResponseDto,
  QueryChatMetricsDto,
  QueryPlatformChatMetricsDto,
} from '../dto/metricas.dto';

const PERIODO_INVALIDO =
  'Fecha que no es AAAA-MM-DD o no existe, «desde» posterior a «hasta», período de más de 366 días o parámetro desconocido';

/** Mensajes → Métricas del panel de la empresa (diseño §15.2 y §16). Módulo `chat`. */
@ApiTags('Inbox (company)')
@RequiereModulo('chat')
@Auth(RoleType.ADMIN)
@Controller({ path: 'chat/metrics', version: '2' })
export class CompanyChatMetricsController {
  constructor(private readonly metricas: ChatMetricsService) {}

  @Get()
  @Permiso('mensajes.supervisar')
  @ApiOperation({
    summary: 'Métricas de los mensajes con clientes y choferes',
    description:
      'De la empresa de quien pide, en el período (por la creación de cada conversación; sin fechas, los últimos 30 días): tiempo de primera respuesta (mediana y p90 en minutos hábiles de su horario de atención y feriados) y cumplimiento de su objetivo, por canal; tiempo de resolución; abiertas, sin asignar y sin respuesta en vivo; el asistente con IA si la empresa lo tiene (resueltas sin persona, derivaciones y motivos, respuestas); respuestas automáticas y rápidas por clave; la encuesta al cerrar y una serie diaria. Sin datos: ceros y `null`.',
  })
  @ApiOkResponse({ type: ChatMetricsResponseDto })
  @ApiBadRequestResponse({
    description: `${PERIODO_INVALIDO}, o canal que no es \`staff_customer\` ni \`staff_driver\``,
  })
  @ApiForbiddenResponse({
    description:
      'Rol que no es del personal de la empresa, sin `mensajes.supervisar` (`PERMISSION_DENIED`) o la empresa no tiene los mensajes (`MODULE_DISABLED`)',
  })
  metricasDeLaEmpresa(
    @CurrentDistributor({ required: true }) distributorId: string,
    @Query() query: QueryChatMetricsDto,
  ): Promise<ChatMetricsResponseDto> {
    return this.metricas.deLaEmpresa(distributorId, query);
  }
}

/** Tablero del soporte y uso del chat por empresa (diseño §15.1 y §16). Sin contenido de mensajes. */
@ApiTags('Platform chat (platform)')
@Auth(RoleType.SUPER_ADMIN)
@SinDistribuidora()
@Controller({ path: 'platform/chat/metrics', version: '2' })
export class PlatformChatMetricsController {
  constructor(private readonly metricas: PlatformChatMetricsService) {}

  @Get()
  @PermisoDePlataforma('plataforma.tickets.ver')
  @ApiOperation({
    summary: 'Métricas del soporte y del chat por empresa',
    description:
      'En el período (sin fechas, los últimos 30 días; con `distributorId`, sólo esa empresa): chat con las empresas (esperando y su espera, primera respuesta en minutos hábiles del horario del soporte, % que terminó en ticket), tickets (abiertos, vencidos, primera respuesta contra su vencimiento, resolución, satisfacción), el asistente del soporte y, por empresa, conversaciones y mensajes (sólo conteos) y su asistente si lo usó. Nunca el texto de un mensaje.',
  })
  @ApiOkResponse({ type: PlatformChatMetricsResponseDto })
  @ApiBadRequestResponse({
    description: `${PERIODO_INVALIDO}, o \`distributorId\` que no es uuid`,
  })
  @ApiForbiddenResponse({
    description: 'Rol que no es administrador general',
  })
  @ApiNotFoundResponse({ description: 'No existe la empresa pedida' })
  metricasDeLaPlataforma(
    @Query() query: QueryPlatformChatMetricsDto,
  ): Promise<PlatformChatMetricsResponseDto> {
    return this.metricas.metricas(query);
  }
}
