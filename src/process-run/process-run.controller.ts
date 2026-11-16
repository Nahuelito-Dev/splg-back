import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { SinDistribuidora } from '../common/decorators/sin-distribuidora.decorator';
import {
  ProcessRunDetailResponseDto,
  ProcessRunListResponseDto,
  ProcessSummaryResponseDto,
} from './dto/process-run-response.dto';
import {
  QueryProcessRunsDto,
  QueryProcessSummaryDto,
} from './dto/query-process-runs.dto';
import { ProcessRunService } from './process-run.service';

/**
 * Monitoreo de los procesos automáticos (API v2): es de la PLATAFORMA. Sólo el
 * administrador general (alcance `plataforma`, aun en una sesión de soporte)
 * ve las corridas de todas las empresas y las globales, filtrables por empresa
 * y proceso. El admin de una empresa recibe 403: la lista de corridas es un
 * tema técnico; los parámetros de negocio de cada proceso siguen en
 * `/module-config/*` de la empresa.
 */
@ApiTags('Procesos automáticos · Monitoreo')
@Auth(RoleType.SUPER_ADMIN)
@SinDistribuidora()
@Controller({ path: 'process-runs', version: '2' })
export class ProcessRunController {
  constructor(private readonly service: ProcessRunService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Última corrida de cada proceso automático, por empresa',
    description:
      'Un renglón por proceso y empresa (y uno por cada proceso global de la plataforma) con su salud: `ok`, `partial`, `running`, `failed`, `late` (no arrancó en 1,5 veces su período), `stuck` (sigue corriendo pasado el máximo) o `never`. Con `distributorId`, sólo los de esa empresa. Sólo el administrador general: el admin de una empresa recibe 403.',
  })
  @ApiOkResponse({ type: ProcessSummaryResponseDto })
  @ApiBadRequestResponse({
    description: '`distributorId` que no es un UUID',
  })
  resumen(
    @Query() query: QueryProcessSummaryDto,
  ): Promise<ProcessSummaryResponseDto> {
    return this.service.resumen(query.distributorId ?? null);
  }

  @Get()
  @ApiOperation({
    summary: 'Historial de corridas de todas las empresas',
    description:
      'Las más nuevas primero, paginado. Filtros: `distributorId` (una empresa), `process`, `status` (p. ej. `failed` para las fallas), `from` y `to` (instantes ISO 8601 sobre el inicio de la corrida). Los atrasos (`late`) y las corridas trabadas salen del resumen. Sólo el administrador general.',
  })
  @ApiOkResponse({ type: ProcessRunListResponseDto })
  @ApiBadRequestResponse({
    description:
      'Filtro inválido: `distributorId` que no es un UUID, `process` o `status` fuera del enum, `from` o `to` que no son fecha ISO 8601, `from` posterior a `to`, `limit` fuera de 1 a 100 u `offset` negativo',
  })
  listar(
    @Query() query: QueryProcessRunsDto,
  ): Promise<ProcessRunListResponseDto> {
    return this.service.listar(query);
  }

  // Va después de `summary`: si no, `/process-runs/summary` caería acá como id.
  @Get(':runId')
  @ApiOperation({
    summary: 'Detalle de una corrida',
    description:
      'Tiempos, disparo y quién la pidió, instancia, contadores, resumen por empresa (`companies`), error saneado con su huella (`errorFingerprint`), la traza (`traceId`, para abrir `GET /v2/platform/traces/{traceId}`) y los avisos de la bandeja que salieron de esa misma traza. Sólo el administrador general.',
  })
  @ApiOkResponse({ type: ProcessRunDetailResponseDto })
  @ApiBadRequestResponse({
    description: '`runId` que no es un UUID (`INVALID_ID`)',
  })
  @ApiNotFoundResponse({
    description:
      'No existe esa corrida o ya se depuró por antigüedad (`PROCESS_RUN_NOT_FOUND`)',
  })
  detalle(
    @Param('runId', ParseUUIDPipe) runId: string,
  ): Promise<ProcessRunDetailResponseDto> {
    return this.service.detalle(runId);
  }
}
