import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Socket } from 'socket.io';
import { AuthService } from '../auth.service';

@Injectable()
export class WsJwtGuard implements CanActivate {
  public constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
  ) {}

  private readonly logger: Logger = new Logger(WsJwtGuard.name);

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'ws') {
      return true;
    }

    const client: Socket = context.switchToWs().getClient();
    await WsJwtGuard.validateToken(client, this.authService);
    return true;
  }

  static async validateToken(client: Socket, authService: AuthService) {
    const token = WsJwtGuard.extractToken(client); // ✅ Remover tipo explícito

    if (!token) {
      throw new UnauthorizedException('No token provided');
    }

    const payload = await authService.decodeToken(token);
    return payload;
  }

  static extractToken(client: Socket): string | null {
    const { authorization } =
      process.env.NODE_ENV !== 'prod' // ✅ Cambiar a NODE_ENV
        ? (client.handshake.auth as any)
        : (client.handshake.headers as any);
    const [type, token] = authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : null;
  }
}
