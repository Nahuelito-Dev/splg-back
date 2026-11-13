import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Auth } from '../common/decorators/auth.decorator';
import { Permiso } from '../common/decorators/permiso.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { MessageResponseDto } from '../common/dtos/message-response.dto';
import { StaffRoleService } from './staff-role.service';
import { StaffRoleMapper } from './staff-role.mapper';
import {
  AdminStaffRoleResponseDto,
  AssignStaffRoleDto,
  CreateStaffRoleDto,
  StaffRoleResponseDto,
  UpdateStaffRoleDto,
} from './dto/staff-role.dto';

const SIN_DISTRIBUIDORA =
  'Super admin sin X-Distributor ("Falta la distribuidora: enviá el header X-Distributor (slug o id)")';

/** Roles del personal del panel de la distribuidora (F37, API v2). */
@ApiTags('Administración · Roles del personal (v2)')
// `@Permiso` arriba de `@Auth`: se aplica último y su 403 (que cubre los dos
// casos) es el que documenta Swagger.
@Permiso('roles.gestionar')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'staff-roles', version: '2' })
export class StaffRoleController {
  constructor(private readonly roles: StaffRoleService) {}

  @Get()
  @ApiOperation({
    summary: 'Listar los roles del personal con su cantidad de administradores',
    description:
      'Primero el rol de sistema («Administrador»), después los demás por nombre. Los dados de baja no aparecen.',
  })
  @ApiOkResponse({ type: StaffRoleResponseDto, isArray: true })
  @ApiBadRequestResponse({ description: SIN_DISTRIBUIDORA })
  async findAll(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<StaffRoleResponseDto[]> {
    const roles = await this.roles.findAll(distributorId);
    return roles.map((r) => StaffRoleMapper.toDto(r.rol, r.adminCount));
  }

  @ApiForbiddenResponse({
    description:
      'Cuenta que no es del panel, administrador sin `roles.gestionar` (`PERMISSION_DENIED`), o permisos que quien crea no tiene: nadie da lo que no tiene (`STAFF_ROLE_PERMISSION_NOT_HELD`)',
  })
  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Crear un rol del personal',
    description:
      'Nombre único en la distribuidora (sin distinguir mayúsculas) y permisos del catálogo (`GET /v2/permissions`).',
  })
  @ApiCreatedResponse({ type: StaffRoleResponseDto })
  @ApiBadRequestResponse({
    description: `Datos inválidos (detalle por campo), permiso fuera del catálogo (\`code: UNKNOWN_PERMISSION\`, con su nombre) o ${SIN_DISTRIBUIDORA}`,
  })
  @ApiConflictResponse({
    description:
      'Ya existe un rol con ese nombre (`code: STAFF_ROLE_NAME_TAKEN`) o la `Idempotency-Key` está en uso por otra solicitud en curso',
  })
  async create(
    @Body() dto: CreateStaffRoleDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<StaffRoleResponseDto> {
    const { rol, adminCount } = await this.roles.create(
      dto,
      distributorId,
      actor,
    );
    return StaffRoleMapper.toDto(rol, adminCount);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Ficha de un rol del personal' })
  @ApiParam({ name: 'id', description: 'Rol UUID' })
  @ApiOkResponse({ type: StaffRoleResponseDto })
  @ApiBadRequestResponse({
    description: `El id no es un UUID o ${SIN_DISTRIBUIDORA}`,
  })
  @ApiNotFoundResponse({
    description: 'No existe, está dado de baja o es de otra distribuidora',
  })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<StaffRoleResponseDto> {
    const { rol, adminCount } = await this.roles.findOne(id, distributorId);
    return StaffRoleMapper.toDto(rol, adminCount);
  }

  @ApiForbiddenResponse({
    description:
      'Cuenta que no es del panel, administrador sin `roles.gestionar` (`PERMISSION_DENIED`), es el rol que tiene asignado quien edita (`STAFF_ROLE_OWN_ROLE`) o le suma permisos que quien edita no tiene (`STAFF_ROLE_PERMISSION_NOT_HELD`)',
  })
  @Patch(':id')
  @Idempotent()
  @ApiOperation({
    summary: 'Editar un rol del personal',
    description:
      'Nombre, descripción o permisos (la lista reemplaza a la anterior). El rol de sistema no se edita. Los administradores que lo tienen ven el cambio en su próxima solicitud.',
  })
  @ApiParam({ name: 'id', description: 'Rol UUID' })
  @ApiOkResponse({ type: StaffRoleResponseDto })
  @ApiBadRequestResponse({
    description: `El id no es un UUID, datos inválidos, permiso fuera del catálogo (\`code: UNKNOWN_PERMISSION\`) o ${SIN_DISTRIBUIDORA}`,
  })
  @ApiNotFoundResponse({
    description: 'No existe, está dado de baja o es de otra distribuidora',
  })
  @ApiConflictResponse({
    description:
      'Es el rol de sistema (`STAFF_ROLE_IS_SYSTEM`), el nombre ya existe (`STAFF_ROLE_NAME_TAKEN`), quitarle `roles.gestionar` dejaría a la distribuidora sin nadie que gestione los roles (`LAST_ROLES_MANAGER`) o la `Idempotency-Key` está en uso',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStaffRoleDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<StaffRoleResponseDto> {
    const { rol, adminCount } = await this.roles.update(
      id,
      dto,
      distributorId,
      actor,
    );
    return StaffRoleMapper.toDto(rol, adminCount);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @Idempotent({ sinCuerpo: true })
  @ApiOperation({
    summary: 'Dar de baja un rol del personal (baja lógica)',
    description:
      'Queda con `deletedAt` y deja de listarse. El rol de sistema y uno que todavía tiene administradores no se dan de baja.',
  })
  @ApiParam({ name: 'id', description: 'Rol UUID' })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiBadRequestResponse({
    description: `El id no es un UUID o ${SIN_DISTRIBUIDORA}`,
  })
  @ApiNotFoundResponse({
    description: 'No existe, ya está dado de baja o es de otra distribuidora',
  })
  @ApiConflictResponse({
    description:
      'Es el rol de sistema (`STAFF_ROLE_IS_SYSTEM`), tiene administradores asignados (`STAFF_ROLE_HAS_ADMINS`) o la `Idempotency-Key` está en uso',
  })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<MessageResponseDto> {
    return this.roles.remove(id, distributorId);
  }
}

/** Asignación del rol del personal a un administrador (F37, API v2). */
@ApiTags('Administración · Roles del personal (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'admins', version: '2' })
export class AdminStaffRoleController {
  constructor(private readonly roles: StaffRoleService) {}

  @ApiForbiddenResponse({
    description:
      'Cuenta que no es del panel, administrador sin `administradores.gestionar` (`PERMISSION_DENIED`), se quiere cambiar el propio rol (`STAFF_ROLE_SELF_ASSIGN`) o el rol tiene permisos que quien asigna no tiene, como el de sistema (`STAFF_ROLE_PERMISSION_NOT_HELD`)',
  })
  @Put(':id/staff-role')
  @Permiso('administradores.gestionar')
  @Idempotent()
  @ApiOperation({
    summary: 'Asignar el rol del personal a un administrador',
    description:
      'El rol y el administrador tienen que ser de la distribuidora. Un administrador no cambia su propio rol y sólo asigna roles cuyos permisos tiene. Siempre queda al menos un administrador activo con `roles.gestionar`. Repetir la misma asignación no cambia nada.',
  })
  @ApiParam({ name: 'id', description: 'Administrador UUID (`adminId`)' })
  @ApiOkResponse({ type: AdminStaffRoleResponseDto })
  @ApiBadRequestResponse({
    description: `El id no es un UUID, \`staffRoleId\` falta o no es un UUID, o ${SIN_DISTRIBUIDORA}`,
  })
  @ApiNotFoundResponse({
    description:
      'El administrador o el rol no existen, están dados de baja o son de otra distribuidora (un super admin tampoco se encuentra)',
  })
  @ApiConflictResponse({
    description:
      'Dejaría a la distribuidora sin nadie que gestione los roles (`LAST_ROLES_MANAGER`) o la `Idempotency-Key` está en uso',
  })
  async assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignStaffRoleDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<AdminStaffRoleResponseDto> {
    return StaffRoleMapper.toAsignacion(
      await this.roles.asignar(id, dto.staffRoleId, distributorId, actor),
    );
  }
}
