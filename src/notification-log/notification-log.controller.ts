import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { Permiso } from '../common/decorators/permiso.decorator';
import {
  NotificationLogItemDto,
  NotificationLogPageDto,
  QueryNotificationLogDto,
} from './dto/notification-log.dto';
import { NotificationLogService } from './notification-log.service';

/**
 * Registro de avisos enviados (API v3): cada push y correo que salió del
 * sistema, con el destino enmascarado y el resultado. Sólo lectura.
 */
@ApiTags('Avisos enviados (v3)')
@Controller({ path: 'notification-log', version: '3' })
export class NotificationLogController {
  constructor(private readonly avisos: NotificationLogService) {}

  @Get()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @Permiso('auditoria.ver')
  @ApiOperation({
    summary: 'Avisos enviados (push y correo)',
    description:
      'Los más nuevos primero, paginado. Filtros: `channel`, `status` (`sent`, `failed`, `skipped`), `type`, `from`/`to` (días, hora de Argentina), `term` (destinatario enmascarado o asunto) y `orderId`. Siempre dentro de una distribuidora: el admin ve los de la suya; el super admin, los de la empresa de su sesión de soporte (sin sesión, 403; no hay vista global). Nunca devuelve el correo ni el token completos ni el id del destinatario.',
  })
  @ApiOkResponse({ type: NotificationLogPageDto })
  @ApiBadRequestResponse({
    description:
      'Filtro inválido: `channel` o `status` fuera del enum, `from`/`to` que no son fecha, `orderId` que no es UUID, `limit` fuera de 1 a 100 u `offset` negativo',
  })
  @ApiForbiddenResponse({
    description:
      'Sin el permiso de auditoría, un rol que no es de gestión, o super admin sin sesión de soporte',
  })
  listar(
    @Query() query: QueryNotificationLogDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<NotificationLogPageDto> {
    return this.avisos.listar(distributorId, query);
  }
}

@ApiTags('Avisos enviados (v3)')
@Controller({ path: 'orders', version: '3' })
export class OrderNotificationsController {
  constructor(private readonly avisos: NotificationLogService) {}

  @Get(':id/notifications')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @Permiso('auditoria.ver')
  @ApiOperation({
    summary: 'Los avisos enviados de un pedido',
    description:
      'Push y correos que se mandaron por este pedido, del más nuevo al más viejo (hasta 200). Con el destino enmascarado. Pide el mismo permiso que el listado (`auditoria.ver`); el super admin entra con sesión de soporte de la empresa.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({ type: [NotificationLogItemDto] })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiForbiddenResponse({
    description:
      'Sin el permiso de auditoría, un rol que no es de gestión, o super admin sin sesión de soporte',
  })
  @ApiNotFoundResponse({
    description: 'Pedido inexistente o de otra distribuidora',
  })
  deUnPedido(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<NotificationLogItemDto[]> {
    return this.avisos.deUnPedido(id, distributorId);
  }
}
