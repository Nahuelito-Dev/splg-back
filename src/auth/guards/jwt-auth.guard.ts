import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from '../auth.service';
import { UsersService } from '../../users/users.service';
import { RequestSource } from '../enum/request-source.enum';
import { User } from '../../users/entities/user.entity';
import { DistributorService } from '../../distributor/distributor.service';
import { RoleType } from '../../common/constants/role-type.enum';
import type { Request } from 'express';

/** Un uuid v4 canónico (para distinguir header X-Distributor id vs slug). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AuthGuard implements CanActivate {
  public constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly distributorService: DistributorService,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    const isPublic = this.reflector.get<boolean | undefined>(
      'isPublic',
      context.getHandler(),
    );

    if (isPublic) {
      return true;
    }

    const token = this.extractTokenFromHeader(request);
    const requestSource = this.extractRequestSourceFromHeader(request);

    if (!requestSource) {
      throw new UnauthorizedException(
        'Invalid or missing X-Client-Source header',
      );
    }

    if (
      !token &&
      request.method === 'POST' &&
      request.url.includes('/auth/login')
    ) {
      const email = emailDelCuerpo(request.body);

      if (!email) {
        throw new UnauthorizedException('Email is required for login');
      }

      const user = await this.usersService.findOneByEmail(email);
      this.validateUserRoleForApp(user, requestSource);

      return true;
    }

    if (!token) {
      throw new UnauthorizedException('No token provided');
    }

    const token_user = await this.authService.decodeToken(token);

    if (!token_user.email) {
      throw new UnauthorizedException('Invalid token payload');
    }

    const local_user = await this.getUser(token_user.email, requestSource);

    const distributor_id = await this.resolveDistributor(local_user, request);

    // getUser ya pasó por validateUserRoleForApp, que rechaza al usuario sin
    // rol o con un rol que no es de esta app: acá el rol es de RoleType.
    request.user = {
      email: local_user.email ?? token_user.email,
      role: local_user.role?.type as RoleType,
      user_id: local_user.userId,
      distributor_id,
    };
    // Tenant efectivo de la request (lo lee @CurrentDistributor()).
    request.distributorId = distributor_id;

    return true;
  }

  /**
   * Resuelve el tenant (distribuidora) efectivo de la request:
   *  - admin/delivery: se DERIVA de su perfil (server-trusted). Se ignora
   *    cualquier header X-Distributor → un staff no puede operar otro tenant.
   *  - customer/super_admin: del header `X-Distributor` (slug o uuid), validado
   *    contra una distribuidora activa. Sin header → null.
   * Devuelve null si no hay tenant en contexto (super_admin cross-tenant, o
   * customer que aún no eligió distribuidora).
   */
  private async resolveDistributor(
    user: User,
    request: Request,
  ): Promise<string | null> {
    const role = user.role?.type;

    // Staff (admin/delivery) DEBE tener una distribuidora en su perfil. Si no la
    // tiene (dato inconsistente), NO se degrada a "ve todo" (eso sería fuga
    // cross-tenant): se rechaza. El super_admin es el único cross-tenant.
    if (role === RoleType.DELIVERY) {
      const id = user.delivery?.distributorId;
      if (!id) {
        throw new UnauthorizedException(
          'El chofer no tiene una distribuidora asignada',
        );
      }
      return id;
    }
    if (role === RoleType.ADMIN) {
      const id = user.admins?.[0]?.distributorId;
      if (!id) {
        throw new UnauthorizedException(
          'El admin no tiene una distribuidora asignada',
        );
      }
      return id;
    }

    // customer / super_admin → header opcional
    const header = request.headers['x-distributor'];
    if (!header || typeof header !== 'string') {
      return null;
    }
    try {
      const distributor = UUID_RE.test(header)
        ? await this.distributorService.assertActive(header)
        : await this.distributorService.findBySlug(header);
      return distributor.distributorId;
    } catch {
      throw new UnauthorizedException(
        `Distribuidora '${header}' inválida o no disponible`,
      );
    }
  }

  private extractTokenFromHeader(request: Request): string | null {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' && token ? token : null;
  }

  private async getUser(
    user_email: string,
    request_source: RequestSource,
  ): Promise<User> {
    let user: User;
    try {
      user = await this.usersService.findOneByEmail(user_email);
      this.validateUserRoleForApp(user, request_source);
    } catch {
      throw new UnauthorizedException(
        'User not found or invalid role for this application',
      );
    }

    // La cuenta bloqueada se rechaza acá y no dentro del try de arriba: si
    // fuera parte de ese bloque, el catch la confundiría con "usuario
    // inexistente" y el administrador que bloqueó no sabría si surtió efecto.
    //
    // Tiene que estar en el guard y no en el login, porque el panel y las dos
    // apps se autentican con el SDK de Firebase y nunca pasan por nuestro
    // endpoint de acceso: el guard es el único lugar por donde pasan todos.
    this.assertCuentaHabilitada(user);

    return user;
  }

  private assertCuentaHabilitada(user: User): void {
    if (user.blocked) {
      throw new UnauthorizedException(
        'La cuenta está bloqueada. Comuníquese con la distribuidora.',
      );
    }
  }

  private validateUserRoleForApp(
    user: User,
    requestSource: RequestSource,
  ): void {
    const userRole = user.role?.type;

    if (!userRole) {
      throw new UnauthorizedException('User does not have a role assigned');
    }

    const validRolesForApp: Record<RequestSource, string[]> = {
      [RequestSource.ADMIN_PANEL]: ['admin', 'super_admin'],
      [RequestSource.CUSTOMER_APP]: ['customer'],
      [RequestSource.DELIVERY_APP]: ['delivery'],
    };

    if (!validRolesForApp[requestSource].includes(userRole)) {
      throw new UnauthorizedException(
        'User role not allowed for this application',
      );
    }
  }

  private extractRequestSourceFromHeader(
    request: Request,
  ): RequestSource | null {
    const requestSource = request.headers['x-client-source'];

    if (!requestSource) {
      return null;
    }

    switch (requestSource) {
      case 'panel-app':
        return RequestSource.ADMIN_PANEL;
      case 'customer-app':
        return RequestSource.CUSTOMER_APP;
      case 'delivery-app':
      case 'driver-app': // alias: la app chofer manda 'driver-app'
        return RequestSource.DELIVERY_APP;
      default:
        return null;
    }
  }
}

function emailDelCuerpo(cuerpo: unknown): string | null {
  if (typeof cuerpo === 'object' && cuerpo !== null && 'email' in cuerpo) {
    return typeof cuerpo.email === 'string' && cuerpo.email
      ? cuerpo.email
      : null;
  }
  return null;
}
