import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleType } from '../constants/role-type.enum';

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name); // ← Agregar Logger

  constructor(private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const requiredRoles = this.reflector.get<RoleType[]>(
      'roles',
      ctx.getHandler(),
    );

    this.logger.debug(
      `🔐 [ROLES GUARD] Required roles: ${JSON.stringify(requiredRoles)}`,
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      this.logger.debug(`✅ [ROLES GUARD] No roles required - access granted`);
      return true;
    }

    const req = ctx.switchToHttp().getRequest();
    const user = req.user;

    this.logger.debug(
      `👤 [ROLES GUARD] User object: ${JSON.stringify({
        email: user?.email,
        role: user?.role,
        user_id: user?.user_id,
      })}`,
    );

    if (!user || !user.role) {
      this.logger.debug(
        `❌ [ROLES GUARD] User not authenticated or missing role`,
      );
      throw new ForbiddenException('User not authenticated or missing role');
    }

    const userRole = user.role;
    this.logger.debug(
      `🎯 [ROLES GUARD] User role: ${userRole}, Required: ${requiredRoles.join(', ')}`,
    );

    // ✅ CORRECCIÓN: Verificar que userRole es un RoleType válido
    const allowed = requiredRoles.includes(userRole as RoleType);

    if (!allowed) {
      this.logger.debug(
        `🚫 [ROLES GUARD] Access denied. User role: ${userRole}, Required: ${requiredRoles.join(', ')}`,
      );
      throw new ForbiddenException(
        `Insufficient role. Required: ${requiredRoles.join(', ')}, User has: ${userRole}`,
      );
    }

    this.logger.debug(`✅ [ROLES GUARD] Access granted for role: ${userRole}`);
    return true;
  }
}
