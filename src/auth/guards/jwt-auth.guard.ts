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

  public async canActivate(context: ExecutionContext): Promise<any> {
    const request = context.switchToHttp().getRequest();

    const isPublic = this.reflector.get('isPublic', context.getHandler());

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
      const body = request.body;

      if (!body || !body.email) {
        throw new UnauthorizedException('Email is required for login');
      }

      const user = await this.usersService.findOneByEmail(body.email);
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

    const user = {
      email: local_user.email,
      role: local_user.role?.type,
      user_id: local_user.user_id,
      distributor_id,
    };

    request['user'] = user;
    // Tenant efectivo de la request (lo lee @CurrentDistributor()).
    request['distributorId'] = distributor_id;

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
    request: any,
  ): Promise<string | null> {
    const role = user.role?.type;

    if (role === RoleType.DELIVERY) {
      return user.delivery?.distributor_id ?? null;
    }
    if (role === RoleType.ADMIN) {
      return user.admins?.[0]?.distributor_id ?? null;
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
      return distributor.distributor_id;
    } catch {
      throw new UnauthorizedException(
        `Distribuidora '${header}' inválida o no disponible`,
      );
    }
  }

  private extractTokenFromHeader(request: any): string | null {
    const authHeader = request.headers.authorization;
    const [type, token] = authHeader?.split(' ') ?? [];
    return type === 'Bearer' ? token : null;
  }

  private async getUser(
    user_email: string,
    request_source: RequestSource,
  ): Promise<User> {
    try {
      const user = await this.usersService.findOneByEmail(user_email);
      this.validateUserRoleForApp(user, request_source);
      return user;
    } catch (error) {
      throw new UnauthorizedException(
        'User not found or invalid role for this application',
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

    const validRolesForApp = {
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

  private extractRequestSourceFromHeader(request: any): RequestSource | null {
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