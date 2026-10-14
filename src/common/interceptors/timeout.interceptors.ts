import {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
  ServiceUnavailableException,
} from '@nestjs/common';
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
  intercept(
    _context: ExecutionContext,
    next: CallHandler<unknown>,
  ): Observable<unknown> {
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
