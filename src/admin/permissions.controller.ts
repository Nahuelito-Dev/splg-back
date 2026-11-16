import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth } from '../common/decorators/auth.decorator';
import { SinDistribuidora } from '../common/decorators/sin-distribuidora.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { StaffPermissionsService } from './staff-permissions.service';
import { StaffRoleMapper } from './staff-role.mapper';
import {
  MyPermissionsResponseDto,
  PermissionModuleResponseDto,
} from './dto/staff-role.dto';
import { Alcance } from '../common/decorators/alcance.decorator';

/** Catálogo de permisos del personal del panel (F37, API v2). */
@ApiTags('Administración · Roles del personal (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@SinDistribuidora()
@Alcance('ambos')
@Controller({ path: 'permissions', version: '2' })
export class PermissionsController {
  @Get()
  @ApiOperation({
    summary: 'Catálogo de permisos, agrupado por módulo del panel',
    description:
      'Es la lista fija del sistema (no depende de la distribuidora). `implies` dice qué otro permiso viene incluido (`gestionar` incluye `ver`).',
  })
  @ApiOkResponse({ type: PermissionModuleResponseDto, isArray: true })
  findAll(): PermissionModuleResponseDto[] {
    return StaffRoleMapper.toCatalogo();
  }
}

/** Permisos efectivos de quien pide (F37, API v2): con esto el panel arma el menú. */
@ApiTags('Administración · Roles del personal (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@SinDistribuidora()
@Alcance('ambos')
@Controller({ path: 'me', version: '2' })
export class MyPermissionsController {
  constructor(private readonly permisos: StaffPermissionsService) {}

  @Get('permissions')
  @ApiOperation({
    summary: 'Mis permisos',
    description:
      'El super admin y el rol de sistema tienen todos (`allPermissions: true`). Para el resto, los de su rol con los `ver` que implica cada `gestionar`.',
  })
  @ApiOkResponse({ type: MyPermissionsResponseDto })
  async mine(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MyPermissionsResponseDto> {
    return StaffRoleMapper.toMisPermisos(
      user.role,
      await this.permisos.deUsuario(
        user.user_id,
        user.role,
        undefined,
        user.actuaComoEmpresaPropia === true,
      ),
    );
  }
}
