import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { auditContext } from './audit-context';
import {
  esGraphql,
  requestDelContexto,
} from '../../common/contexto/request-del-contexto';

/**
 * Abre el contexto de auditoría de datos para el handler. Corre después de los
 * guards (global, como `AuditInterceptor`), así que ya conoce al usuario y a su
 * distribuidora. El handler arranca al suscribirse, por eso `run` envuelve la
 * suscripción y no la llamada a `next.handle()`.
 */
@Injectable()
export class AuditContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // GraphQL también: el modo soporte abre en sólo lectura toda transacción
    // del request (segunda capa), sea REST o un resolver.
    if (context.getType() !== 'http' && !esGraphql(context)) {
      return next.handle();
    }
    const request = requestDelContexto(context);
    const ip: unknown = request.ip;
    const store = {
      userId: request.user?.user_id ?? null,
      ip: typeof ip === 'string' && ip ? ip.slice(0, 45) : null,
      distributorId: request.distributorId ?? null,
      soporte: request.supportSession
        ? {
            alcance: request.supportSession.scope,
            vence: request.supportSession.expiresAt,
          }
        : undefined,
    };
    return new Observable((subscriber) =>
      auditContext.run(store, () => next.handle().subscribe(subscriber)),
    );
  }
}
