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

@Injectable()
export class AuthGuard implements CanActivate {
  public constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
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

    const user = {
      email: local_user.email,
      role: local_user.role?.type,
      user_id: local_user.user_id,
    };

    request['user'] = user;

    return true;
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
        return RequestSource.DELIVERY_APP;
      default:
        return null;
    }
  }
}