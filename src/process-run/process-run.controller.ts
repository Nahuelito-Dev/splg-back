import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import {
  ProcessRunListResponseDto,
  ProcessSummaryResponseDto,
} from './dto/process-run-response.dto';
import { QueryProcessRunsDto } from './dto/query-process-runs.dto';
import { ProcessRunService } from './process-run.service';
import { Permiso } from '../common/decorators/permiso.decorator';

/**
 * Monitoreo de los procesos automáticos (API v2). El admin ve las corridas de
 * su distribuidora y las globales; el super admin, las de la distribuidora que
 * elige con `X-Distributor` o, sin el header, las de todas. Una corrida de otra
 * distribuidora nunca aparece.
 */
@ApiTags('Procesos automáticos · Monitoreo')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'process-runs', version: '2' })
export class ProcessRunController {
  constructor(private readonly service: ProcessRunService) {}

  @Permiso('configuracion.ver')
  @Get('summary')
  @ApiOperation({
    summary: 'Última corrida de cada proceso automático',
    description:
      'Un renglón por proceso con su salud: `ok`, `partial`, `running`, `failed`, `late` (no arrancó en 1,5 veces su período), `stuck` (sigue corriendo pasado el máximo) o `never`. Cliente y chofer reciben 403. De los procesos globales, el admin de una empresa ve sólo la salud (sin contadores ni texto de error); el administrador general ve todo.',
  })
  @ApiOkResponse({ type: ProcessSummaryResponseDto })
  resumen(
    @CurrentDistributor() distributorId: string | null,
    @CurrentUser('role') role: RoleType,
  ): Promise<ProcessSummaryResponseDto> {
    return this.service.resumen(distributorId, role === RoleType.SUPER_ADMIN);
  }

  @Permiso('configuracion.ver')
  @Get()
  @ApiOperation({
    summary: 'Historial de corridas',
    description:
      'Las más nuevas primero, paginado. Filtros: `process`, `status`, `from` y `to` (instantes ISO 8601 sobre el inicio de la corrida).',
  })
  @ApiOkResponse({ type: ProcessRunListResponseDto })
  @ApiBadRequestResponse({
    description:
      'Filtro inválido: `process` o `status` fuera del enum, `from` o `to` que no son fecha ISO 8601, `from` posterior a `to`, `limit` fuera de 1 a 100 u `offset` negativo',
  })
  listar(
    @Query() query: QueryProcessRunsDto,
    @CurrentDistributor() distributorId: string | null,
    @CurrentUser('role') role: RoleType,
  ): Promise<ProcessRunListResponseDto> {
    return this.service.listar(
      distributorId,
      role === RoleType.SUPER_ADMIN,
      query,
    );
  }
}
