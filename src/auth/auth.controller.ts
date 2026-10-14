import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto, SesionIniciadaDto, TokenValidoResponseDto } from './dto';
import { Public } from '../common/decorators/isPublic.decorator';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post()
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Validar el token de sesión',
    description:
      'Si la petición llega acá, el guard ya validó el token y la cuenta.',
  })
  @ApiCreatedResponse({ type: TokenValidoResponseDto })
  @ApiUnauthorizedResponse({ description: 'Token inválido o vencido' })
  checkToken(): TokenValidoResponseDto {
    return this.authService.checkIfTokenValid();
  }

  // El cupo estricto de acceso NO va por IP: lo lleva el throttler 'cuenta'
  // (8/min por cuenta, ver AppThrottlerGuard). Acá queda el cupo por IP del
  // throttler por defecto, que es el techo amplio contra un host que pruebe
  // muchas cuentas. Ponerle 8 por IP volvería a bloquear entre sí a los
  // usuarios que comparten IP pública.
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Iniciar sesión desde las apps' })
  @ApiOkResponse({ type: SesionIniciadaDto })
  @ApiUnauthorizedResponse({
    description:
      'Email o contraseña incorrectos (misma respuesta para un usuario inexistente y para una contraseña equivocada) o cuenta dada de baja (Firebase la rechaza antes de mirar la clave: misma respuesta, no revela que existe). Con la clave correcta, una cuenta bloqueada recibe `La cuenta no está habilitada`',
  })
  @ApiTooManyRequestsResponse({ description: 'Demasiados intentos fallidos' })
  login(@Body() dto: LoginDto): Promise<SesionIniciadaDto> {
    return this.authService.login(dto);
  }

  // Mismo criterio de cupo que el login de las apps.
  @Public()
  @Post('login/dashboard')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Iniciar sesión en el panel' })
  @ApiOkResponse({ type: SesionIniciadaDto })
  @ApiUnauthorizedResponse({
    description:
      'Email o contraseña incorrectos, cuenta no habilitada o no es de un administrador',
  })
  @ApiTooManyRequestsResponse({ description: 'Demasiados intentos fallidos' })
  async dashboardLogin(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SesionIniciadaDto> {
    const sesion = await this.authService.login(dto);

    await this.authService.loginDashboard(sesion.accessToken);

    res.cookie('token', sesion.accessToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 1000 * 60 * 60,
    });

    return sesion;
  }
}
