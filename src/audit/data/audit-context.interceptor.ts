import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { auditContext } from './audit-context';

/**
 * Abre el contexto de auditoría de datos para el handler. Corre después de los
 * guards (global, como `AuditInterceptor`), así que ya conoce al usuario y a su
 * distribuidora. El handler arranca al suscribirse, por eso `run` envuelve la
 * suscripción y no la llamada a `next.handle()`.
 */
@Injectable()
export class AuditContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Request>();
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
