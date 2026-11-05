import type { Response } from 'express';
import { ApiTotal, informarTotal } from '../common/http/total';
import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  Res,
  UploadedFile,
  ParseUUIDPipe,
  HttpStatus,
  HttpCode,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiBearerAuth,
  ApiOkResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { User } from './entities/user.entity';
import { UsersService } from './users.service';
import { UserPhotoService } from './user-photo.service';
import { DownloadQueryDto } from '../s3/dto/download-link.dto';
import {
  ApiSubirFoto,
  ApiVerFoto,
  responderFoto,
  SubirFotoInterceptor,
} from '../s3/photo-http';
import { UpdateUserDto } from './dto/update-user.dto';
import { QueryUsersDto } from './dto/query-users.dto';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/isPublic.decorator';
import { CheckUserExistsDto } from './dto/check-user-exists.dto';
import { BlockUserDto } from './dto/block-user.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import {
  esAdministrador,
  esElMismoUsuario,
} from '../common/utils/alcance.util';
import {
  CurrentDistributor,
  faltaLaDistribuidora,
} from '../common/decorators/current-distributor.decorator';
import { MessageResponseDto } from '../common/dtos/message-response.dto';
import { UserMapper } from './user.mapper';
import { UserResponseDto } from './dto/user-response.dto';
import { EmailParamDto, TelefonoParamDto } from './dto/usuario-params.dto';
import {
  BloqueoDeUsuarioDto,
  ListadoDeUsuariosDto,
  UsuarioExisteDto,
} from './dto/usuarios-response.dto';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly userPhoto: UserPhotoService,
  ) {}

  /** El DTO del usuario con `photoUrl` como URL firmada vigente. */
  private async toDto(user: User): Promise<UserResponseDto> {
    await this.userPhoto.firmar(user);
    return UserMapper.toDto(user);
  }

  @Get('email/:email')
  @ApiOperation({
    summary: 'Get user by email',
    description:
      'Devuelve el usuario con su rol, perfil y direcciones. Exige ' +
      'token: era publico y cualquiera podia leer los datos de una cuenta ' +
      'con solo conocer el correo. Para saber si un correo ya esta en uso ' +
      'esta POST /users/check-exists, que contesta solo booleanos.',
  })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiBadRequestResponse({ description: 'No es un correo' })
  @ApiForbiddenResponse({ description: 'No es su cuenta' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  async findOneByEmail(
    @Param() { email }: EmailParamDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<UserResponseDto> {
    // H-65: las apps lo usan para leer la cuenta propia al entrar; ver la de
    // otro queda para el panel.
    if (
      !esAdministrador(user) &&
      email.trim().toLowerCase() !== user.email.toLowerCase()
    ) {
      throw new ForbiddenException('No podés ver a otro usuario');
    }
    const encontrado = await this.usersService.findOneByEmail(email);
    if (esAdministrador(user) && !esElMismoUsuario(encontrado.userId, user)) {
      await this.assertDeSuDistribuidora(encontrado.userId, distributorId);
    }
    return this.toDto(encontrado);
  }

  @Get()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Get all users with pagination and search',
    description:
      '`term` busca en correo, nombre y teléfono; `role` filtra por tipo ' +
      'de rol. Un admin de empresa ve sólo los usuarios de su distribuidora ' +
      '(H-66); un super admin ve todos, o los de la distribuidora que ' +
      'indique en `X-Distributor`. Orden: fecha de alta, la más nueva ' +
      'primero (con la misma fecha, por id).',
  })
  @ApiOkResponse({ type: ListadoDeUsuariosDto })
  @ApiTotal()
  @ApiBadRequestResponse({ description: 'role inválido' })
  async findAll(
    @Query() paginationDto: QueryUsersDto,
    @Res({ passthrough: true }) res: Response,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<ListadoDeUsuariosDto> {
    const { users, maxUsers } = await this.usersService.findAll(
      paginationDto,
      distributorId,
    );
    informarTotal(res, maxUsers);
    await this.userPhoto.firmar(users);
    return { users: users.map((u) => UserMapper.toDto(u)), maxUsers };
  }

  @Put('me/photo')
  @ApiSubirFoto(
    'Subir o reemplazar mi foto de perfil',
    UserResponseDto,
    'La sube cada usuario (cliente, chofer o admin) para su propia cuenta.',
    { conNotFound: false },
  )
  @SubirFotoInterceptor()
  async uploadMyPhoto(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    return UserMapper.toDto(await this.userPhoto.subir(user.user_id, file));
  }

  @Delete('me/photo')
  @ApiOperation({
    summary: 'Sacar mi foto de perfil',
    description:
      'Quita la referencia a la foto (el objeto se borra del bucket en ' +
      'segundo plano). No da de baja la cuenta.',
  })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  async removeMyPhoto(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    return UserMapper.toDto(await this.userPhoto.quitar(user.user_id));
  }

  @Get('me/photo')
  @ApiVerFoto('Ver mi foto de perfil')
  async getMyPhoto(
    @Query() query: DownloadQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ): Promise<void> {
    responderFoto(res, query.modo, await this.userPhoto.enlace(user.user_id));
  }

  @Delete('me')
  @Auth(RoleType.CUSTOMER)
  @ApiOperation({
    summary: 'El cliente da de baja su propia cuenta (baja lógica)',
    description:
      'Su usuario, perfil y direcciones quedan dados de baja y dejan de ' +
      'aparecer; sus pedidos y registros se conservan. La cuenta de Firebase ' +
      'se deshabilita, no se borra. **Es definitivo desde la app**: no puede ' +
      'volver a iniciar sesión, el correo y el teléfono quedan reservados ' +
      '(no se puede registrar de nuevo con los mismos: 409) y, para ' +
      'reactivarla, tiene que contactar a la distribuidora. Si tiene pedidos ' +
      'en curso (reservados, pendientes, aceptados o en camino, en cualquier ' +
      'distribuidora) se rechaza con 409. Con el token anterior, el servidor ' +
      'responde 401: la sesión terminó con la baja.',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiConflictResponse({
    description: 'Tiene pedidos en curso: hay que esperar o cancelarlos',
  })
  @HttpCode(HttpStatus.OK)
  async removeMe(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MessageResponseDto> {
    return await this.usersService.removeOwnAccount(user.user_id);
  }

  @Put(':id/photo')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiSubirFoto(
    'Subir o reemplazar la foto de perfil de un usuario',
    UserResponseDto,
    'Un admin de empresa sólo la de su personal (choferes y admins de su ' +
      'distribuidora); la de un cliente es de su propia cuenta o del ' +
      'administrador general (403 para el admin de empresa).',
  )
  @ApiForbiddenResponse({ description: 'Es la cuenta de un cliente' })
  @ApiParam({ name: 'id', description: 'User UUID' })
  @SubirFotoInterceptor()
  async uploadPhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<UserResponseDto> {
    if (!esElMismoUsuario(id, user)) {
      await this.assertPuedeAdministrar(id, user, distributorId);
    }
    return UserMapper.toDto(await this.userPhoto.subir(id, file));
  }

  @Delete(':id/photo')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Sacar la foto de perfil de un usuario',
    description:
      'Mismas reglas que subirla. Quita la referencia (el objeto se borra ' +
      'del bucket en segundo plano); no da de baja al usuario.',
  })
  @ApiParam({ name: 'id', description: 'User UUID' })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiForbiddenResponse({ description: 'Es la cuenta de un cliente' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  async removePhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<UserResponseDto> {
    if (!esElMismoUsuario(id, user)) {
      await this.assertPuedeAdministrar(id, user, distributorId);
    }
    return UserMapper.toDto(await this.userPhoto.quitar(id));
  }

  @Get(':id/photo')
  @ApiVerFoto(
    'Ver la foto de perfil de un usuario',
    'El id no es un UUID o el modo no es válido',
  )
  @ApiParam({ name: 'id', description: 'User UUID' })
  @ApiForbiddenResponse({ description: 'No es su cuenta' })
  async getPhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DownloadQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
    @Res() res: Response,
  ): Promise<void> {
    if (!esAdministrador(user) && !esElMismoUsuario(id, user)) {
      throw new ForbiddenException('No podés ver a otro usuario');
    }
    if (esAdministrador(user) && !esElMismoUsuario(id, user)) {
      await this.assertDeSuDistribuidora(id, distributorId);
    }
    responderFoto(res, query.modo, await this.userPhoto.enlace(id));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get user by ID' })
  @ApiParam({ name: 'id', description: 'User UUID' })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiForbiddenResponse({ description: 'No es su cuenta' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<UserResponseDto> {
    if (!esAdministrador(user) && !esElMismoUsuario(id, user)) {
      throw new ForbiddenException('No podés ver a otro usuario');
    }
    if (esAdministrador(user) && !esElMismoUsuario(id, user)) {
      await this.assertDeSuDistribuidora(id, distributorId);
    }
    return this.toDto(await this.usersService.findOne(id));
  }

  @Get('phone/:phoneNumber')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get user by phone number' })
  @ApiOkResponse({
    type: UserResponseDto,
    description: 'El usuario, o vacío si nadie tiene ese teléfono',
  })
  @ApiBadRequestResponse({ description: 'No está en formato E.164' })
  @ApiNotFoundResponse({ description: 'Es de otra distribuidora' })
  async findOneByPhone(
    @Param() { phoneNumber }: TelefonoParamDto,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<UserResponseDto | null> {
    const encontrado = await this.usersService.findOneByPhone(phoneNumber);
    if (!encontrado) return null;
    await this.assertDeSuDistribuidora(encontrado.userId, distributorId);
    return this.toDto(encontrado);
  }

  @Public()
  @Post('check-exists')
  // Público y con respuesta booleana: sirve para enumerar cuentas. Cupo bajo por
  // IP (sin sesión el tracker es la IP) para que no se pueda recorrer una lista.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Check if user exists by email or phone',
    description:
      'Público. Máximo 10 consultas por minuto y por IP (429): contesta si una cuenta existe, así que no puede usarse para recorrer listas.',
  })
  @ApiTooManyRequestsResponse({ description: 'Superó el cupo por minuto' })
  @ApiOkResponse({ type: UsuarioExisteDto })
  @ApiBadRequestResponse({ description: 'Sin correo ni teléfono' })
  @HttpCode(HttpStatus.OK)
  async checkUserExists(
    @Body() dto: CheckUserExistsDto,
  ): Promise<UsuarioExisteDto> {
    return await this.usersService.checkUserExists(dto.email, dto.phoneNumber);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update user by ID' })
  @ApiParam({ name: 'id', description: 'User UUID' })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiForbiddenResponse({
    description:
      'No es su cuenta, pide contraseña o bloqueo sin ser admin, o es la cuenta de un cliente',
  })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({
    description:
      'Teléfono en uso por otro usuario (aunque esté dado de baja), o sin cuenta de acceso',
  })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: Se envió un dato que no corresponde: Correo electrónico; Teléfono: fuera del formato E.164 +549...)',
  })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateUserDto: UpdateUserDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<UserResponseDto> {
    const isAdmin = esAdministrador(user);

    // Ownership: un no-admin SOLO puede modificarse a sí mismo (anti-IDOR), y
    // sólo sus datos de contacto.
    if (!isAdmin && !esElMismoUsuario(id, user)) {
      throw new ForbiddenException('No podés modificar a otro usuario');
    }

    if (isAdmin) {
      if (updateUserDto.blocked === true && esElMismoUsuario(id, user)) {
        throw new ForbiddenException('No podés bloquearte a vos mismo');
      }
      await this.assertPuedeAdministrar(id, user, distributorId);
    }

    // Contraseña y bloqueo son de administración: rechazarlos en lugar de
    // ignorarlos, para que nadie crea que cambió algo que no cambió.
    if (
      !isAdmin &&
      (updateUserDto.password !== undefined ||
        updateUserDto.blocked !== undefined)
    ) {
      throw new ForbiddenException(
        'Sólo un administrador puede cambiar la contraseña o el bloqueo',
      );
    }

    const payload = isAdmin
      ? updateUserDto
      : this.pickSelfEditableFields(updateUserDto);

    return this.toDto(await this.usersService.update(id, payload));
  }

  /**
   * Un administrador con distribuidora en contexto (admin de empresa, o super
   * admin con "ver como") sólo ve usuarios de ella: sus choferes, sus admins
   * y los clientes que le compraron o que ella dio de alta. Si no, 404: no se revela que existe
   * (H-66).
   */
  /**
   * La cuenta propia no se acota: el administrador general que eligió una
   * distribuidora con "Ver como" no pertenece a ella y tiene que poder leerse
   * al entrar. El 404 no nombra el id: para quien pregunta, no existe.
   */
  private async assertDeSuDistribuidora(
    userId: string,
    distributorId: string | null,
  ): Promise<void> {
    if (!distributorId) return;
    if (!(await this.usersService.perteneceA(userId, distributorId))) {
      throw new NotFoundException('Usuario no encontrado');
    }
  }

  /**
   * Modificar, bloquear o borrar una cuenta. Además de ser de su
   * distribuidora, un admin de empresa sólo administra a su personal
   * (choferes y admins). Un cliente puede comprarle a varias distribuidoras:
   * resetearle la contraseña o bloquearlo desde una afectaría a las otras,
   * así que su cuenta la administra el administrador general (H-66, H-73).
   */
  private async assertPuedeAdministrar(
    userId: string,
    user: AuthenticatedUser,
    distributorId: string | null,
  ): Promise<void> {
    // El super admin sin distribuidora sólo opera sobre cuentas que no son de
    // ninguna: otro super admin o un cliente (que puede comprarle a varias,
    // H-66, H-73). Sobre el personal de una distribuidora, por UUID, tiene que
    // decir en cuál actúa.
    if (user.role === RoleType.SUPER_ADMIN && !distributorId) {
      const { rol } = await this.usersService.findAlcance(userId);
      if (
        rol !== String(RoleType.SUPER_ADMIN) &&
        rol !== String(RoleType.CUSTOMER)
      ) {
        throw faltaLaDistribuidora();
      }
    }
    await this.assertDeSuDistribuidora(userId, distributorId);
    if (user.role !== RoleType.ADMIN) return;
    const destino = await this.usersService.findAlcance(userId);
    // Un super admin no es de ninguna distribuidora (H-62, H-76).
    if (destino.rol === RoleType.SUPER_ADMIN) {
      throw new NotFoundException('Usuario no encontrado');
    }
    if (destino.rol === RoleType.CUSTOMER) {
      throw new ForbiddenException(
        'La cuenta de un cliente la administra el administrador general',
      );
    }
  }

  /** Campos que un usuario puede cambiar de su propio perfil. */
  private pickSelfEditableFields(dto: UpdateUserDto): Partial<UpdateUserDto> {
    const { full_name, phone_number } = dto;
    return {
      ...(full_name !== undefined && { full_name }),
      ...(phone_number !== undefined && { phone_number }),
    };
  }

  @Delete(':id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Dar de baja un usuario (baja lógica)',
    description:
      'El usuario y sus perfiles quedan dados de baja y dejan de aparecer; ' +
      'sus pedidos y registros se conservan. La cuenta de Firebase se ' +
      'deshabilita, no se borra (H-74). Un chofer con pedidos en curso no se ' +
      'puede dar de baja (409).',
  })
  @ApiParam({ name: 'id', description: 'User UUID' })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiForbiddenResponse({
    description: 'Es la cuenta de un cliente, o la propia',
  })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({
    description:
      'Es un chofer con pedidos aceptados o en camino (hay que cancelarlos o reasignarlos antes), un chofer con una rendición pendiente (CU-181), o el último administrador activo de su distribuidora o el último super administrador',
  })
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<MessageResponseDto> {
    if (esElMismoUsuario(id, user)) {
      throw new ForbiddenException('No podés darte de baja a vos mismo');
    }
    await this.assertPuedeAdministrar(id, user, distributorId);
    return await this.usersService.remove(id);
  }

  @Patch(':id/block')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'ADMIN: Bloquear/Desbloquear usuario',
    description:
      'Nadie se bloquea a sí mismo, y no se bloquea al último administrador ' +
      'activo de una distribuidora ni al último super administrador.',
  })
  @ApiParam({ name: 'id', description: 'User UUID' })
  @ApiOkResponse({ type: BloqueoDeUsuarioDto })
  @ApiForbiddenResponse({
    description: 'Es la cuenta de un cliente, o la propia (al bloquear)',
  })
  @ApiConflictResponse({
    description:
      'Es el último administrador activo de su distribuidora o el último super administrador',
  })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: Bloquear: tiene que ser verdadero o falso)',
  })
  async blockUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BlockUserDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<BloqueoDeUsuarioDto> {
    if (dto.block && esElMismoUsuario(id, user)) {
      throw new ForbiddenException('No podés bloquearte a vos mismo');
    }
    await this.assertPuedeAdministrar(id, user, distributorId);
    return this.usersService.toggleBlockUser(id, dto.block);
  }
}
