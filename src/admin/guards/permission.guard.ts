import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { RoleType } from '../../common/constants/role-type.enum';
import { PERMISO_KEY } from '../../common/decorators/permiso.decorator';
import { CODIGOS_DE_ERROR, conCodigo } from '../../common/errors/con-codigo';
import {
  etiquetaDelPermiso,
  type Permiso,
} from '../../common/permisos/catalogo';
import { StaffPermissionsService } from '../staff-permissions.service';

/**
 * Autorización por permiso del personal del panel (F37). Guard GLOBAL que corre
 * después de `RolesGuard`: si el endpoint no declara `@Permiso(...)` deja pasar
 * (la migración a permisos es gradual). Si declara, sólo restringe a los
 * `admin`: el `super_admin` pasa siempre y las cuentas de las apps ya las
 * filtró `@Auth`. El admin necesita al menos uno de los permisos declarados.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permisos: StaffPermissionsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const objetivos = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>('isPublic', objetivos)) {
      return true;
    }
    const requeridos = this.reflector.getAllAndOverride<Permiso[] | undefined>(
      PERMISO_KEY,
      objetivos,
    );
    if (!requeridos || requeridos.length === 0) return true;

    const { user } = ctx.switchToHttp().getRequest<Request>();
    if (!user?.role) {
      throw new ForbiddenException('Usuario no autenticado o sin rol');
    }
    if (user.role !== RoleType.ADMIN) return true;

    const { permisos } = await this.permisos.deUsuario(user.user_id, user.role);
    if (requeridos.some((p) => permisos.includes(p))) return true;

    throw conCodigo(
      ForbiddenException,
      403,
      `No tenés permiso para ${requeridos.map(etiquetaDelPermiso).join(' ni para ')}`,
      CODIGOS_DE_ERROR.PERMISSION_DENIED,
    );
  }
}
