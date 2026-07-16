import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

const isAdmin = (u: AuthenticatedUser) =>
  u.role === RoleType.ADMIN || u.role === RoleType.SUPER_ADMIN;

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationService: NotificationsService) {}

  // Endpoint de debug: mandar un push arbitrario. Solo admin (no es tráfico de
  // usuario final — el push real lo dispara el flujo de pedido internamente).
  @Post('send-test')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Send a test notification (admin/debug)' })
  @ApiResponse({ status: 200, description: 'Notification sent' })
  async sendTestNotification(
    @Body() body: { token: string; title: string; body: string },
  ) {
    return await this.notificationService.sendTestNotification(
      body.token,
      body.title,
      body.body,
    );
  }

  // Interno/soporte: el push de confirmación real lo dispara el use-case de
  // creación de pedido; este endpoint es para admin (reenvío manual).
  @Post('order-confirmation')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Send order confirmation notification (admin)' })
  @ApiResponse({ status: 200, description: 'Notification sent' })
  async sendOrderConfirmation(
    @Body() body: { customerId: string; orderId: string; token?: string },
  ) {
    return await this.notificationService.sendOrderConfirmation(
      body.customerId,
      body.orderId,
      body.token,
    );
  }

  @Get('user/:userId')
  @ApiOperation({ summary: 'Get notification tokens for user (self o admin)' })
  @ApiResponse({ status: 200, description: 'Tokens found' })
  async getUserTokens(
    @Param('userId') userId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!isAdmin(user) && userId !== user.user_id) {
      throw new ForbiddenException('No autorizado a ver tokens de otro usuario');
    }
    return await this.notificationService.getUserNotificationTokens(userId);
  }

  @Post('token')
  @ApiOperation({ summary: 'Save notification token for the current user' })
  @ApiResponse({ status: 200, description: 'Token saved' })
  async saveToken(
    @Body() body: { userId: string; token: string; platform: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // Anti-secuestro: un no-admin solo puede registrar SU propio token (se fuerza
    // el userId al del token, ignorando el del body). Así userA no puede setear
    // el token de userB para robarle los push ni para dejarlo sin notificaciones.
    const userId = isAdmin(user) ? body.userId : user.user_id;
    return await this.notificationService.saveNotificationToken(
      userId,
      body.token,
      body.platform,
    );
  }
}
