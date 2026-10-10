import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiConflictResponse,
} from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { AdminMapper } from './admin.mapper';
import { UpdateAdminDto } from './dto/update-admin.dto';
import { MessageResponseDto } from '../common/dtos/message-response.dto';
import type { Admin } from './entities/admin.entity';
import { CreateAdminDto } from './dto/create-admin.dto';
import { BuscarAdminParamDto } from './dto/buscar-admin-param.dto';
import { ListarAdminsQueryDto } from './dto/listar-admins-query.dto';
import {
  AdminResponseDto,
  AdminVistaResponseDto,
} from './dto/admin-response.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { esElMismoUsuario } from '../common/utils/alcance.util';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Post()
  @Auth(RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Create admin (basic)' })
  @ApiCreatedResponse({ type: AdminResponseDto })
  @ApiBadRequestResponse({
    description:
      'Sólo un usuario con rol admin o super_admin tiene perfil de administrador · property role_id should not exist; user_id must be a UUID',
  })
  async create(
    @Body() createAdminDto: CreateAdminDto,
  ): Promise<AdminResponseDto> {
    return AdminMapper.toDto(await this.adminService.create(createAdminDto));
  }

  @Get('/term/:term')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Find admin by term (id o correo)' })
  @ApiOkResponse({ type: AdminVistaResponseDto })
  @ApiNotFoundResponse({ description: 'No hay un admin con ese id o correo' })
  async findOneByEmail(
    @Param() { term }: BuscarAdminParamDto,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<AdminVistaResponseDto> {
    return AdminMapper.toVista(
      await this.adminService.findAdminByTerm(term, distributorId),
    );
  }

  @Get()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Get all admins (scopeado por distribuidora)',
    description:
      'Un admin de empresa ve los de la suya. El super admin ve los de la ' +
      'distribuidora que elija con `?distributorId=` (aunque esté "viendo ' +
      'como" otra), o los de la distribuidora en contexto, o todos si no hay.',
  })
  @ApiOkResponse({ type: AdminResponseDto, isArray: true })
  @ApiBadRequestResponse({ description: 'distributorId no es un UUID' })
  @ApiForbiddenResponse({
    description:
      'Un admin de empresa pidió los admins de otra distribuidora (`distributorId`)',
  })
  async findAll(
    @Query() { distributorId: pedida }: ListarAdminsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() contexto: string | null,
  ): Promise<AdminResponseDto[]> {
    let distributorId = contexto;
    if (user.role === RoleType.SUPER_ADMIN) {
      distributorId = pedida ?? contexto;
    } else if (pedida && pedida !== contexto) {
      throw new ForbiddenException(
        'No podés ver los administradores de otra distribuidora',
      );
    }
    const admins = await this.adminService.findAll(distributorId);
    return admins.map((a) => AdminMapper.toDto(a));
  }

  @Get(':id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Ficha de un administrador (scopeado por distribuidora)',
    description:
      'La edición y la baja del administrador van por `/users` (es un usuario ' +
      'con perfil de admin).',
  })
  @ApiOkResponse({ type: AdminResponseDto })
  @ApiNotFoundResponse({
    description: 'No existe o es de otra distribuidora',
  })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<AdminResponseDto> {
    return AdminMapper.toDto(
      await this.adminService.findDetail(id, distributorId),
    );
  }

  @Patch(':id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Editar los datos de un administrador',
    description:
      'Nombre y teléfono (`fullName`, `phoneNumber`). El correo cambia por ' +
      '`POST /email/change-email`; el bloqueo por `PATCH /users/:id/block`. ' +
      'El super admin edita a cualquiera; un admin de empresa sólo a los ' +
      'de su distribuidora, nunca a sí mismo (sus datos van por ' +
      '`PATCH /users/:id`) ni a un super admin.',
  })
  @ApiOkResponse({ type: AdminResponseDto })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: phoneNumber debe estar en formato E.164; property email should not exist)',
  })
  @ApiForbiddenResponse({
    description: 'Un admin de empresa se editó a sí mismo',
  })
  @ApiNotFoundResponse({
    description:
      'No existe, está dado de baja, es de otra distribuidora o es un super admin (para un admin de empresa)',
  })
  @ApiConflictResponse({ description: 'El teléfono ya lo usa otra cuenta' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAdminDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<AdminResponseDto> {
    await this.assertPuedeAdministrar(id, user, distributorId);
    return AdminMapper.toDto(
      await this.adminService.update(id, dto, distributorId),
    );
  }

  @Delete(':id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Dar de baja a un administrador (baja lógica)',
    description:
      'Es la baja del usuario (`DELETE /users/:id`): queda con `deletedAt`, ' +
      'su cuenta de acceso se deshabilita y nada se borra. Mismos permisos ' +
      'que la edición, y nadie se da de baja a sí mismo. No se puede dar de ' +
      'baja al último administrador activo de una distribuidora ni al último ' +
      'super administrador.',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiForbiddenResponse({
    description: 'Se dio de baja a sí mismo (también el super admin)',
  })
  @ApiNotFoundResponse({
    description:
      'No existe, ya está dado de baja, es de otra distribuidora o es un super admin (para un admin de empresa)',
  })
  @ApiConflictResponse({
    description:
      'Es el último administrador activo de la distribuidora o el último super administrador',
  })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<MessageResponseDto> {
    const destino = await this.assertPuedeAdministrar(id, user, distributorId);
    if (esElMismoUsuario(destino.userId, user)) {
      throw new ForbiddenException('No podés darte de baja a vos mismo');
    }
    return this.adminService.remove(id, distributorId);
  }

  /**
   * El super admin administra a cualquiera. Un admin de empresa sólo a los de
   * su distribuidora (el contexto acota la búsqueda: otra responde 404), nunca
   * a un super admin (404, no se revela) ni a sí mismo (403).
   */
  private async assertPuedeAdministrar(
    id: string,
    user: AuthenticatedUser,
    distributorId: string | null,
  ): Promise<Admin> {
    const destino = await this.adminService.findDetail(id, distributorId);
    if (user.role === RoleType.SUPER_ADMIN) return destino;
    if (destino.user?.role?.type === String(RoleType.SUPER_ADMIN)) {
      throw new NotFoundException(`Admin with ID: ${id} not found`);
    }
    if (esElMismoUsuario(destino.userId, user)) {
      throw new ForbiddenException(
        'No podés modificar ni dar de baja tu propio perfil de administrador',
      );
    }
    return destino;
  }
}
