import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  ResultadoDeEnvioDto,
  TokensDeUsuarioDto,
} from './dto/notification-response.dto';
import { NotificationsService } from './notifications.service';
import { Auth } from '../common/decorators/auth.decorator';
import { SendTestNotificationDto } from './dto/send-test-notification.dto';
import { SendOrderConfirmationDto } from './dto/send-order-confirmation.dto';
import { SaveNotificationTokenDto } from './dto/save-notification-token.dto';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationService: NotificationsService) {}

  // Endpoint de debug: mandar un push arbitrario. Sólo el super administrador,
  // como POST /email/test (H-58): un admin de empresa podía mandar pushes con
  // el proyecto de Firebase de la plataforma a cualquier dispositivo.
  @Post('send-test')
  @Auth(RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Send a test notification (admin/debug)' })
  @ApiCreatedResponse({ type: ResultadoDeEnvioDto })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: Token: no puede estar vacío; Título: tiene que tener como máximo 100 caracteres)',
  })
  async sendTestNotification(
    @Body() dto: SendTestNotificationDto,
  ): Promise<ResultadoDeEnvioDto> {
    return await this.notificationService.sendTestNotification(
      dto.token,
      dto.title,
      dto.body,
    );
  }

  // Interno/soporte: el push de confirmación real lo dispara el use-case de
  // creación de pedido; este endpoint es el reenvío manual. Sólo el super
  // administrador: recibe un cliente y un pedido cualquiera, de cualquier
  // distribuidora, y el panel no lo usa.
  @Post('order-confirmation')
  @Auth(RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Send order confirmation notification (admin)' })
  @ApiCreatedResponse({ type: ResultadoDeEnvioDto })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: Cliente: no es válido; Pedido: no es válido)',
  })
  @ApiNotFoundResponse({ description: 'El cliente no existe' })
  async sendOrderConfirmation(
    @Body() dto: SendOrderConfirmationDto,
  ): Promise<ResultadoDeEnvioDto> {
    return await this.notificationService.reenviarConfirmacion(
      dto.customerId,
      dto.orderId,
      dto.token,
    );
  }

  @Get('user/:userId')
  @ApiOperation({ summary: 'Get notification tokens for user (self o admin)' })
  @ApiOkResponse({ type: TokensDeUsuarioDto })
  @ApiForbiddenResponse({ description: 'Tokens de otro usuario' })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  async getUserTokens(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TokensDeUsuarioDto> {
    // Los tokens de otro usuario sólo los ve el super administrador: un admin
    // de empresa no tiene por qué leer los de usuarios de otra distribuidora.
    if (user.role !== RoleType.SUPER_ADMIN && userId !== user.user_id) {
      throw new ForbiddenException(
        'No autorizado a ver tokens de otro usuario',
      );
    }
    return await this.notificationService.getUserNotificationTokens(userId);
  }

  @Post('token')
  @ApiOperation({ summary: 'Save notification token for the current user' })
  @ApiCreatedResponse({ type: ResultadoDeEnvioDto })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: Usuario: no es válido; Token: no puede estar vacío)',
  })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  async saveToken(
    @Body() dto: SaveNotificationTokenDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ResultadoDeEnvioDto> {
    // Anti-secuestro: cada uno registra SU propio token (se fuerza
    // el userId al del token, ignorando el del body). Así userA no puede setear
    // el token de userB para robarle los push ni para dejarlo sin notificaciones.
    const userId =
      user.role === RoleType.SUPER_ADMIN ? dto.userId : user.user_id;
    return await this.notificationService.saveNotificationToken(
      userId,
      dto.token,
      dto.platform,
    );
  }
}
