import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { RoleType } from '../../common/constants/role-type.enum';
import {
  AuditActionTypeDto,
  AuditEntriesPageV2Dto,
  AuditEntryV2Dto,
  QueryAuditEntriesV2Dto,
} from './data-audit.dto';
import { DataAuditService } from './data-audit.service';

/**
 * Auditoría de datos, v2: lo mismo que la v1 más de dónde salió cada asiento
 * (`origin`, `source`, `tableName`, `dbUser`, `appName`) y el filtro `origin`.
 * La v1 conserva su respuesta.
 */
@ApiTags('Audit')
@Controller({ path: 'audit', version: '2' })
export class DataAuditV2Controller {
  constructor(private readonly service: DataAuditService) {}

  @Get('entries')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Consultar la auditoría de datos (con origen del asiento)',
    description:
      'Como la v1, con `origin` (`user`, `system`, `direct`) para distinguir ' +
      'lo hecho por un usuario, por la propia API sin usuario (crons, procesos) ' +
      'y lo escrito directo en la base (SQL a mano, scripts), y en cada asiento ' +
      '`source`, `tableName`, `dbUser` y `appName`. Un admin de empresa ve sólo ' +
      'lo de su distribuidora; el super admin ve todo o la que elige con ' +
      'X-Distributor.',
  })
  @ApiOkResponse({ type: AuditEntriesPageV2Dto })
  findAll(
    @Query() filtros: QueryAuditEntriesV2Dto,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<AuditEntriesPageV2Dto> {
    return this.service.findAllV2(filtros, distributorId);
  }

  @Get('entries/:id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Una auditoría de datos con sus detalles (con origen del asiento)',
  })
  @ApiOkResponse({ type: AuditEntryV2Dto })
  @ApiNotFoundResponse({
    description: 'No existe, o es de otra distribuidora',
  })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<AuditEntryV2Dto> {
    return this.service.findOneV2(id, distributorId);
  }

  @Get('action-types')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Catálogo de acciones auditadas',
    description:
      'TipoAccionAuditoria: Alta, Modificación, Baja lógica, Reactivación, ' +
      'Baja física, Ingreso, Ingreso fallido y Salida.',
  })
  @ApiOkResponse({ type: AuditActionTypeDto, isArray: true })
  findActionTypes(): Promise<AuditActionTypeDto[]> {
    return this.service.findActionTypes();
  }
}
