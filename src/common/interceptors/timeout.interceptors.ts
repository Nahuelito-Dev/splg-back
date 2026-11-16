import {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SIN_TIMEOUT_KEY } from '../decorators/sin-timeout.decorator';
import {
  Observable,
  TimeoutError,
  catchError,
  throwError,
  timeout,
} from 'rxjs';

export const TIMEOUT_HTTP_MS = 120_000;

export const MENSAJE_TIMEOUT =
  'La operación tardó demasiado. Esperá un momento y revisá si se registró antes de reintentar.';

export class TimeoutInterceptor implements NestInterceptor {
  private sinTimeout(context: ExecutionContext): boolean {
    const handler = context.getHandler?.();
    return handler
      ? Reflect.getMetadata(SIN_TIMEOUT_KEY, handler) === true
      : false;
  }

  intercept(
    context: ExecutionContext,
    next: CallHandler<unknown>,
  ): Observable<unknown> {
    if (this.sinTimeout(context)) return next.handle();
    return next.handle().pipe(
      timeout(TIMEOUT_HTTP_MS),
      catchError((err: unknown) =>
        throwError(() =>
          err instanceof TimeoutError
            ? new ServiceUnavailableException(MENSAJE_TIMEOUT)
            : err,
        ),
      ),
    );
  }
}
