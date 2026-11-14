import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { SOLO_LECTURA_KEY } from '../../audit/solo-lectura.decorator';
import { resolverAlcance } from '../alcance/resolver-alcance';
import { RoleType } from '../constants/role-type.enum';
import {
  soloLecturaDeSoporte,
  soporteRequerido,
  soporteSinAlcance,
} from '../errors/soporte';
import { ALCANCE_DE_SOPORTE_KEY } from '../decorators/alcance-de-soporte.decorator';

/** Los métodos que no escriben: los únicos que pasan en modo soporte. */
export const METODOS_DE_LECTURA: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'OPTIONS',
]);

/**
 * Modo soporte del administrador general (guard GLOBAL, después de
 * `PermissionGuard`). Sólo mira al `super_admin`:
 *
 * | Alcance      | Sin sesión                       | Con sesión activa           |
 * |--------------|----------------------------------|-----------------------------|
 * | `plataforma` | pasa                             | pasa (`AuthGuard` no la usa) |
 * | `ambos`      | pasa (versión de plataforma)     | pasa, sólo lectura          |
 * | `empresa`    | 403 `SUPPORT_SESSION_REQUIRED`   | pasa, sólo lectura          |
 *
 * Alcance: un endpoint marcado `@RequiereAlcanceDeSoporte('files' | 'exports')`
 * pide ese alcance en la sesión (si no, 403 `SUPPORT_SCOPE_REQUIRED`).
 *
 * Sólo lectura: con sesión pasan `GET`, `HEAD`, `OPTIONS` y los `POST` marcados
 * `@SoloLectura()`; cualquier otra cosa es 403 `SUPPORT_READ_ONLY`. La segunda
 * capa (la transacción de la base en sólo lectura) la pone `ActorEnLaBase`.
 */
@Injectable()
export class AlcanceGuard implements CanActivate {
  private readonly logger = new Logger(AlcanceGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== 'http') return true;
    const request = ctx.switchToHttp().getRequest<Request>();
    if (request.user?.role !== RoleType.SUPER_ADMIN) return true;

    const objetivos: [object, object] = [ctx.getHandler(), ctx.getClass()];
    const alcance = resolverAlcance(this.reflector, objetivos);
    if (alcance === null || alcance === 'plataforma') return true;

    const sesion = request.supportSession;
    if (!sesion) {
      if (alcance === 'ambos') return true;
      this.logger.log(
        `Sin sesión de soporte: ${request.method} ${patron(request)} (usuario ${request.user.user_id})`,
      );
      throw soporteRequerido();
    }

    const requerido = this.reflector.getAllAndOverride<string | undefined>(
      ALCANCE_DE_SOPORTE_KEY,
      objetivos as Array<() => void>,
    );
    if (requerido && !sesion.scope.includes(requerido)) {
      this.logger.warn(
        `Alcance «${requerido}» que la sesión no tiene: ${request.method} ${patron(request)} (sesión ${sesion.id})`,
      );
      throw soporteSinAlcance(requerido);
    }
    if (METODOS_DE_LECTURA.has(request.method)) return true;
    const soloLectura = this.reflector.getAllAndOverride<boolean | undefined>(
      SOLO_LECTURA_KEY,
      objetivos as Array<() => void>,
    );
    if (soloLectura) return true;
    this.logger.warn(
      `Escritura rechazada en modo soporte: ${request.method} ${patron(request)} (sesión ${sesion.id})`,
    );
    throw soloLecturaDeSoporte();
  }
}

/** La ruta como patrón (sin ids ni correos en el log). */
function patron(request: Request): string {
  const ruta: unknown = (request.route as { path?: unknown } | undefined)?.path;
  return typeof ruta === 'string' ? ruta : request.path;
}
