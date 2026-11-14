import type { AuthenticatedUser } from '../decorators/current-user.decorator';
import type { SesionDeSoporteEnCurso } from './sesion-de-soporte';

/**
 * Lo que el backend le agrega a la petición de Express en el camino:
 *  - `requestIdMiddleware`: `requestId` y `startTime`.
 *  - `AuthGuard`: `user`, `distributorId` y, en modo soporte, `supportSession`;
 *    si el super admin opera una empresa propia de la plataforma,
 *    `ownedCompanyId` (la misma que `distributorId`) y un usuario efectivo
 *    con rol ADMIN; el rol real se conserva para auditoría.
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
    supportSession?: SesionDeSoporteEnCurso;
    ownedCompanyId?: string;
  }
}
