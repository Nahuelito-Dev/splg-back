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
  AuditEntriesPageDto,
  AuditEntryDto,
  QueryAuditEntriesDto,
} from './data-audit.dto';
import { DataAuditService } from './data-audit.service';
import { Permiso } from '../../common/decorators/permiso.decorator';

/**
 * Auditoría de datos según el modelo de la cátedra: Auditoria,
 * DetalleAuditoria y TipoAccionAuditoria. Distinta de la bitácora de requests
 * (`GET /audit`, CU-152): acá se ve qué registro y qué campos cambiaron.
 */
@ApiTags('Audit')
@Controller('audit')
export class DataAuditController {
  constructor(private readonly service: DataAuditService) {}

  @Get('entries')
  @Permiso('auditoria.ver')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Consultar la auditoría de datos',
    description:
      'Una Auditoria por registro afectado (tipo de acción, usuario, ' +
      'entidadAfectada, idRegistro, ipUsuario, fechaHora) con sus ' +
      'DetalleAuditoria (campo, valorAnterior, valorNuevo). Un admin de ' +
      'empresa ve sólo lo de su distribuidora; el super admin ve todo o la ' +
      'que elige con X-Distributor.',
  })
  @ApiOkResponse({ type: AuditEntriesPageDto })
  findAll(
    @Query() filtros: QueryAuditEntriesDto,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<AuditEntriesPageDto> {
    return this.service.findAll(filtros, distributorId);
  }

  @Get('entries/:id')
  @Permiso('auditoria.ver')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Una auditoría de datos con sus detalles',
    description: 'Una Auditoria con todos sus DetalleAuditoria.',
  })
  @ApiOkResponse({ type: AuditEntryDto })
  @ApiNotFoundResponse({
    description: 'No existe, o es de otra distribuidora',
  })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<AuditEntryDto> {
    return this.service.findOne(id, distributorId);
  }

  @Get('action-types')
  @Permiso('auditoria.ver')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Catálogo de acciones auditadas',
    description:
      'TipoAccionAuditoria: Alta, Modificación, Baja lógica y Reactivación.',
  })
  @ApiOkResponse({ type: AuditActionTypeDto, isArray: true })
  findActionTypes(): Promise<AuditActionTypeDto[]> {
    return this.service.findActionTypes();
  }
}
