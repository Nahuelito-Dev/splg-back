import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
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
import type { Request, Response } from 'express';
import { AuthService, MENSAJE_CREDENCIALES } from './auth.service';
import { LoginDto, SesionIniciadaDto, TokenValidoResponseDto } from './dto';
import { Public } from '../common/decorators/isPublic.decorator';
import {
  CanalDeIngreso,
  SesionAuditService,
} from '../audit/data/sesion-audit.service';
import { errorCode } from '../common/errors/error-message';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly sesiones: SesionAuditService,
  ) {}

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
  login(
    @Body() dto: LoginDto,
    @Req() req: Request,
  ): Promise<SesionIniciadaDto> {
    return this.auditado(dto, req, 'app', () => this.authService.login(dto));
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
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SesionIniciadaDto> {
    const sesion = await this.auditado(dto, req, 'panel', async () => {
      const iniciada = await this.authService.login(dto);
      await this.authService.loginDashboard(iniciada.accessToken);
      return iniciada;
    });

    res.cookie('token', sesion.accessToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 1000 * 60 * 60,
    });

    return sesion;
  }

  /** Corre el ingreso y deja asentado en la auditoría si salió bien o falló. */
  private async auditado(
    dto: LoginDto,
    req: Request,
    canal: CanalDeIngreso,
    ingresar: () => Promise<SesionIniciadaDto>,
  ): Promise<SesionIniciadaDto> {
    const cabecera = req.headers['x-client-source'];
    const evento = {
      email: dto.email,
      canal,
      origen: typeof cabecera === 'string' ? cabecera : null,
      ip: typeof req.ip === 'string' ? req.ip : null,
    };
    try {
      const sesion = await ingresar();
      await this.sesiones.registrarIngreso({ ...evento, ok: true });
      return sesion;
    } catch (error) {
      await this.sesiones.registrarIngreso({
        ...evento,
        ok: false,
        motivo: motivoDelRechazo(error),
      });
      throw error;
    }
  }
}

/** Texto fijo del porqué: nunca el mensaje de Firebase ni datos de la cuenta. */
function motivoDelRechazo(error: unknown): string {
  if (error instanceof UnauthorizedException) {
    const mensaje = error.message;
    if (mensaje === MENSAJE_CREDENCIALES) return 'credenciales incorrectas';
    if (mensaje === 'Admin not found')
      return 'la cuenta no es de un administrador';
    return 'cuenta no habilitada';
  }
  if (error instanceof HttpException && error.getStatus() === 429) {
    return 'demasiados intentos';
  }
  return errorCode(error) ?? 'servicio no disponible';
}
