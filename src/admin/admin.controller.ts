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
import {
  CurrentDistributor,
  faltaLaDistribuidora,
} from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { Permiso } from '../common/decorators/permiso.decorator';

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
      'Sólo un usuario con rol admin o super_admin tiene perfil de administrador · el perfil de un admin de empresa exige X-Distributor y que coincida con distributor_id · Se envió un dato que no corresponde: Rol; Usuario: no es válido',
  })
  @ApiNotFoundResponse({ description: 'El usuario no existe' })
  @ApiConflictResponse({
    description: 'El usuario ya tiene perfil de administrador',
  })
  async create(
    @Body() createAdminDto: CreateAdminDto,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<AdminResponseDto> {
    return AdminMapper.toDto(
      await this.adminService.create(createAdminDto, distributorId),
    );
  }

  @Get('/term/:term')
  @Permiso('administradores.gestionar')
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
  @Permiso('administradores.gestionar')
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
  @Permiso('administradores.gestionar')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Ficha de un administrador (scopeado por distribuidora)',
    description:
      'La edición y la baja del administrador van por `/users` (es un usuario ' +
      'con perfil de admin).',
  })
  @ApiOkResponse({ type: AdminResponseDto })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
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
  @Permiso('administradores.gestionar')
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
      'Datos inválidos (p. ej.: Teléfono: tiene que estar en formato E.164; Se envió un dato que no corresponde: Correo electrónico)',
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
  @Permiso('administradores.gestionar')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Dar de baja a un administrador (baja lógica)',
    description:
      'Es la baja del usuario (`DELETE /users/:id`): queda con `deletedAt`, ' +
      'su cuenta de acceso se deshabilita y nada se borra. Mismos permisos ' +
      'que la edición, y nadie se da de baja a sí mismo. No se puede dar de ' +
      'baja al último administrador activo de una distribuidora ni al último ' +
      'super administrador. El administrador de una distribuidora dada de ' +
      'baja lo da de baja el super admin sin `X-Distributor` (con ella en el ' +
      'header responde 401), y ahí no se exige que quede otro administrador.',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiBadRequestResponse({
    description:
      'El id no es un UUID, o super admin sin `X-Distributor` sobre un administrador de una distribuidora vigente',
  })
  @ApiForbiddenResponse({
    description: 'Se dio de baja a sí mismo (también el super admin)',
  })
  @ApiNotFoundResponse({
    description:
      'No existe, ya está dado de baja, es de otra distribuidora o es un super admin (para un admin de empresa)',
  })
  @ApiConflictResponse({
    description:
      'Es el último administrador activo de la distribuidora o el último super administrador, o el último administrador activo que puede gestionar los roles y permisos de la distribuidora (`LAST_ROLES_MANAGER`)',
  })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<MessageResponseDto> {
    const destino = await this.assertPuedeAdministrar(id, user, distributorId, {
      sinDistribuidoraSiEstaEliminada: true,
    });
    if (esElMismoUsuario(destino.userId, user)) {
      throw new ForbiddenException('No podés darte de baja a vos mismo');
    }
    return this.adminService.remove(id, distributorId);
  }

  /**
   * El super admin administra a cualquiera. Un admin de empresa sólo a los de
   * su distribuidora (el contexto acota la búsqueda: otra responde 404), nunca
   * a un super admin (404, no se revela) ni a sí mismo (403).
   *
   * `sinDistribuidoraSiEstaEliminada` (la baja): el super admin, sin
   * `X-Distributor`, opera sobre el admin de una distribuidora dada de baja
   * (con ella en el header el guard ya responde 401).
   */
  private async assertPuedeAdministrar(
    id: string,
    user: AuthenticatedUser,
    distributorId: string | null,
    opciones: { sinDistribuidoraSiEstaEliminada?: boolean } = {},
  ): Promise<Admin> {
    const destino = await this.adminService.findDetail(id, distributorId);
    if (user.role === RoleType.SUPER_ADMIN) {
      // Sin distribuidora sólo se opera sobre otro super admin (que no es de
      // ninguna); sobre un admin de empresa, por UUID, hay que decir en cuál.
      if (
        !distributorId &&
        destino.user?.role?.type !== String(RoleType.SUPER_ADMIN) &&
        !(
          opciones.sinDistribuidoraSiEstaEliminada &&
          (await this.adminService.esDeUnaDistribuidoraEliminada(destino))
        )
      ) {
        throw faltaLaDistribuidora();
      }
      return destino;
    }
    if (destino.user?.role?.type === String(RoleType.SUPER_ADMIN)) {
      throw new NotFoundException('Administrador no encontrado');
    }
    if (esElMismoUsuario(destino.userId, user)) {
      throw new ForbiddenException(
        'No podés modificar ni dar de baja tu propio perfil de administrador',
      );
    }
    return destino;
  }
}
