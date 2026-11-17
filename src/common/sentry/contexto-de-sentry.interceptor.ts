import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { contextoDeSentry } from './contexto-de-sentry';

/**
 * Pone en Sentry el contexto de cada request HTTP (usuario, empresa, cliente y
 * request id) apenas pasaron los guards, que son los que resuelven el usuario y
 * la empresa. Todo lo que se mande a Sentry durante la request (errores, logs,
 * trazas) lo lleva.
 */
@Injectable()
export class ContextoDeSentryInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      contextoDeSentry(context.switchToHttp().getRequest<Request>());
    }
    return next.handle();
  }
}
