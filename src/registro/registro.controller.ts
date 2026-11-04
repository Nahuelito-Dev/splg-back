import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RegistroService } from './registro.service';
import {
  RegistrarClienteDto,
  RegistrarUsuarioDto,
} from './dto/registrar-usuario.dto';
import { Public } from '../common/decorators/isPublic.decorator';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { UserResponseDto } from '../users/dto/user-response.dto';
import { UserMapper } from '../users/user.mapper';

/**
 * Las dos puertas del alta de usuarios. El caso de uso es uno solo
 * (`RegistroService`); cambia quién pide:
 * - `POST /auth/registro`, pública: siempre un cliente, con cupo por IP.
 * - `POST /users`, panel: el rol va en el cuerpo y lo autoriza la política.
 *
 * Viven en este controlador y no en el de `users` porque el alta depende de
 * los módulos de cada perfil, que a su vez dependen de `users`.
 */
@Controller()
export class RegistroController {
  constructor(private readonly registro: RegistroService) {}

  // Cupo propio, más estricto que el global: un alta crea una cuenta en
  // Firebase y manda un correo.
  @Public()
  @Post('auth/registro')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiTags('Auth')
  @ApiOperation({ summary: 'Registrarse como cliente (CU-002)' })
  @ApiCreatedResponse({ type: UserResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiConflictResponse({ description: 'Email o teléfono ya en uso' })
  @ApiTooManyRequestsResponse({ description: 'Demasiadas altas seguidas' })
  async registrarCliente(
    @Body() dto: RegistrarClienteDto,
  ): Promise<UserResponseDto> {
    const user = await this.registro.registrar(
      { ...dto, rol: RoleType.CUSTOMER },
      { tipo: 'anonimo' },
    );
    return UserMapper.toDto(user);
  }

  // La ruta que usan las versiones publicadas de la app de clientes. Se
  // retira cuando la app nueva (que llama a /auth/registro) esté en las
  // tiendas.
  @Public()
  @Post('users/customer-registration')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiTags('Auth')
  @ApiOperation({
    summary: 'Registrarse como cliente (ruta anterior de /auth/registro)',
    deprecated: true,
  })
  @ApiCreatedResponse({ type: UserResponseDto })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: Correo electrónico: tiene que ser un correo electrónico válido; Contraseña: tiene que tener al menos 6 caracteres)',
  })
  @ApiConflictResponse({ description: 'Email o teléfono ya en uso' })
  registrarClienteRutaAnterior(
    @Body() dto: RegistrarClienteDto,
  ): Promise<UserResponseDto> {
    return this.registrarCliente(dto);
  }

  @Post('users')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiTags('Users')
  @ApiOperation({
    summary: 'Dar de alta un usuario de cualquier rol (CU-003, CU-031, CU-086)',
    description:
      'Un admin crea clientes, choferes y admins de su distribuidora; un ' +
      'super admin, cualquier rol en cualquier distribuidora.',
  })
  @ApiCreatedResponse({ type: UserResponseDto })
  @ApiBadRequestResponse({
    description: 'Datos inválidos o falta la distribuidora',
  })
  @ApiForbiddenResponse({
    description: 'El rol o la distribuidora no le corresponden',
  })
  @ApiConflictResponse({ description: 'Email o teléfono ya en uso' })
  async registrar(
    @Body() dto: RegistrarUsuarioDto,
    @CurrentUser() usuario: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<UserResponseDto> {
    const user = await this.registro.registrar(
      dto,
      { tipo: 'usuario', usuario },
      distributorId,
    );
    return UserMapper.toDto(user);
  }
}
