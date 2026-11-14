import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AdminNotificationsService } from './admin-notifications.service';
import {
  AdminNotificationListResponseDto,
  AdminNotificationResponseDto,
  ReadAllResponseDto,
  UnreadCountResponseDto,
} from './dto/admin-notification-response.dto';
import { QueryAdminNotificationsDto } from './dto/query-admin-notifications.dto';
import { Alcance } from '../common/decorators/alcance.decorator';

/**
 * Bandeja de avisos del panel (API v2). El admin ve la de su distribuidora; el
 * super admin, la del `X-Distributor` si lo manda y, si no, las de todas. Cada
 * administrador marca como leído lo suyo.
 */
@ApiTags('Admin notifications')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Alcance('ambos')
@Controller({ path: 'admin-notifications', version: '2' })
export class AdminNotificationsController {
  constructor(private readonly service: AdminNotificationsService) {}
  @Get()
  @ApiOperation({
    summary: 'Bandeja de avisos',
    description:
      'Los más nuevos primero. `readAt` es la lectura de quien consulta. Con `unread=true` sólo los que no leyó; con `unread=false`, sólo los leídos.',
  })
  @ApiOkResponse({ type: AdminNotificationListResponseDto })
  @ApiBadRequestResponse({ description: 'Filtro o paginación inválidos' })
  listar(
    @Query() query: QueryAdminNotificationsDto,
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<AdminNotificationListResponseDto> {
    return this.service.listar(userId, distributorId, query);
  }
  @Get('unread-count')
  @ApiOperation({ summary: 'Cuántos avisos no leí' })
  @ApiOkResponse({ type: UnreadCountResponseDto })
  contarSinLeer(
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<UnreadCountResponseDto> {
    return this.service.contarSinLeer(userId, distributorId);
  }
  @Patch('read-all')
  @ApiOperation({
    summary: 'Marcar todos como leídos',
    description:
      'Sólo los avisos de la distribuidora en contexto y sólo para quien pide.',
  })
  @ApiOkResponse({ type: ReadAllResponseDto })
  marcarTodosLeidos(
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<ReadAllResponseDto> {
    return this.service.marcarTodosLeidos(userId, distributorId);
  }
  @Patch(':id/read')
  @ApiOperation({
    summary: 'Marcar un aviso como leído',
    description:
      'Idempotente: si ya estaba leído devuelve la lectura original.',
  })
  @ApiOkResponse({ type: AdminNotificationResponseDto })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiNotFoundResponse({
    description: 'No existe, o es de otra distribuidora',
  })
  marcarLeido(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<AdminNotificationResponseDto> {
    return this.service.marcarLeido(userId, distributorId, id);
  }
}
