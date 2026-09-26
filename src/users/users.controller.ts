import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
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
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { Public } from '../common/decorators/isPublic.decorator';
import { CheckUserExistsDto } from './dto/check-user-exists.dto';
import { BlockUserDto } from './dto/block-user.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { esAdministrador } from '../common/utils/alcance.util';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
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
  constructor(private readonly usersService: UsersService) {}

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
    if (esAdministrador(user)) {
      await this.assertDeSuDistribuidora(encontrado.user_id, distributorId);
    }
    return UserMapper.toDto(encontrado);
  }

  @Get()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Get all users with pagination and search',
    description:
      '`term` busca en correo, nombre y teléfono. Un admin de empresa ve ' +
      'sólo los usuarios de su distribuidora (H-66).',
  })
  @ApiOkResponse({ type: ListadoDeUsuariosDto })
  async findAll(
    @Query() paginationDto: PaginationDto,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<ListadoDeUsuariosDto> {
    const { users, maxUsers } = await this.usersService.findAll(
      paginationDto,
      distributorId,
    );
    return { users: users.map((u) => UserMapper.toDto(u)), maxUsers };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get user by ID' })
  @ApiParam({ name: 'id', description: 'User UUID' })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiForbiddenResponse({ description: 'No es su cuenta' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<UserResponseDto> {
    if (!esAdministrador(user) && id !== user.user_id) {
      throw new ForbiddenException('No podés ver a otro usuario');
    }
    if (esAdministrador(user)) {
      await this.assertDeSuDistribuidora(id, distributorId);
    }
    return UserMapper.toDto(await this.usersService.findOne(id));
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
    await this.assertDeSuDistribuidora(encontrado.user_id, distributorId);
    return UserMapper.toDto(encontrado);
  }

  @Public()
  @Post('check-exists')
  @ApiOperation({ summary: 'Check if user exists by email or phone' })
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
    description: 'Teléfono en uso, o sin cuenta de acceso',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateUserDto: UpdateUserDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<UserResponseDto> {
    const isAdmin = esAdministrador(user);

    // Ownership: un no-admin SOLO puede modificarse a sí mismo (anti-IDOR), y
    // sólo sus datos de contacto.
    if (!isAdmin && id !== user.user_id) {
      throw new ForbiddenException('No podés modificar a otro usuario');
    }

    if (isAdmin) {
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

    return UserMapper.toDto(await this.usersService.update(id, payload));
  }

  /**
   * Un administrador con distribuidora en contexto (admin de empresa, o super
   * admin con "ver como") sólo ve usuarios de ella: sus choferes, sus admins
   * y los clientes que le compraron. Si no, 404: no se revela que existe
   * (H-66).
   */
  private async assertDeSuDistribuidora(
    userId: string,
    distributorId: string | null,
  ): Promise<void> {
    if (!distributorId) return;
    if (!(await this.usersService.perteneceA(userId, distributorId))) {
      throw new NotFoundException(`User with ID: ${userId} not found`);
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
    await this.assertDeSuDistribuidora(userId, distributorId);
    if (user.role !== RoleType.ADMIN) return;
    const destino = await this.usersService.findAlcance(userId);
    // Un super admin no es de ninguna distribuidora (H-62, H-76).
    if (destino.rol === RoleType.SUPER_ADMIN) {
      throw new NotFoundException(`User with ID: ${userId} not found`);
    }
    if (destino.rol === RoleType.CUSTOMER) {
      throw new ForbiddenException(
        'La cuenta de un cliente la administra el administrador general',
      );
    }
  }

  /** Campos que un usuario puede cambiar de su propio perfil. */
  private pickSelfEditableFields(dto: UpdateUserDto): Partial<UpdateUserDto> {
    const { full_name, phone_number, selfie } = dto;
    return {
      ...(full_name !== undefined && { full_name }),
      ...(phone_number !== undefined && { phone_number }),
      ...(selfie !== undefined && { selfie }),
    };
  }

  @Delete(':id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Dar de baja un usuario (baja lógica)',
    description:
      'El usuario y sus perfiles quedan dados de baja y dejan de aparecer; ' +
      'sus pedidos y registros se conservan. La cuenta de Firebase se ' +
      'deshabilita, no se borra (H-74).',
  })
  @ApiParam({ name: 'id', description: 'User UUID' })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiForbiddenResponse({ description: 'Es la cuenta de un cliente' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<MessageResponseDto> {
    await this.assertPuedeAdministrar(id, user, distributorId);
    return await this.usersService.remove(id);
  }

  @Patch(':id/block')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'ADMIN: Bloquear/Desbloquear usuario' })
  @ApiParam({ name: 'id', description: 'User UUID' })
  @ApiOkResponse({ type: BloqueoDeUsuarioDto })
  @ApiForbiddenResponse({ description: 'Es la cuenta de un cliente' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async blockUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BlockUserDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<BloqueoDeUsuarioDto> {
    await this.assertPuedeAdministrar(id, user, distributorId);
    return this.usersService.toggleBlockUser(id, dto.block);
  }
}
