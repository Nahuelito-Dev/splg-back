import type { AuthenticatedUser } from '../decorators/current-user.decorator';

/**
 * Lo que el backend le agrega a la petición de Express en el camino:
 *  - `requestIdMiddleware`: `requestId` y `startTime`.
 *  - `AuthGuard`: `user` y `distributorId`.
 *
 * Declararlo acá es lo que permite leer `context.switchToHttp().getRequest<Request>()`
 * con tipos, en lugar de tratar la petición como `any`.
 */
declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
    startTime?: number;
    user?: AuthenticatedUser;
    distributorId?: string | null;
  }
}
