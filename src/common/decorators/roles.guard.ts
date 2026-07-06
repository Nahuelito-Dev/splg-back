import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleType } from '../constants/role-type.enum';
import { ROLES_KEY } from './roles.decorator';

/**
 * Autorización por rol. Se registra como guard GLOBAL (APP_GUARD) después de
 * `AuthGuard`, así que corre en todas las rutas: si el handler (o su controller)
 * no declara `@Roles(...)`, deja pasar; si declara, exige que el rol del usuario
 * autenticado esté entre los permitidos.
 *
 * Lee la metadata a nivel de método Y de clase (`getAllAndOverride`), lo que
 * permite proteger un controller entero con un único `@Roles()` en la clase.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    // Las rutas @Public() no tienen usuario autenticado: nunca exigimos rol,
    // aunque el controller declare @Roles a nivel de clase.
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<RoleType[]>(
      ROLES_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const { user } = ctx.switchToHttp().getRequest();

    if (!user || !user.role) {
      throw new ForbiddenException('Usuario no autenticado o sin rol');
    }

    if (!requiredRoles.includes(user.role as RoleType)) {
      throw new ForbiddenException(
        `Acceso denegado. Requiere rol: ${requiredRoles.join(', ')}`,
      );
    }

    return true;
  }
}
