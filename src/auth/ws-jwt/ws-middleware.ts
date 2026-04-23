import { Socket } from 'socket.io';
import { WsJwtGuard } from '../guards/ws-jwt.guard';
import { AuthService } from '../auth.service';

export type SocketIOMiddleware = {
  (client: Socket, next: (err?: Error) => void);
};

export const SocketAuthMiddleware = (
  authService: AuthService,
): SocketIOMiddleware => {
  return async (client, next) => {
    try {
      await WsJwtGuard.validateToken(client, authService);
      next();
    } catch (error) {
      next(error);
    }
  };
};
