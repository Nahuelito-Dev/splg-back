import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';

/**
 * Logging estructurado de requests HTTP (observabilidad, C4).
 *
 * Loguea, para CADA request exitoso: método, path, status, duración (ms) y
 * el `request-id` (seteado por `requestIdMiddleware`). Registrado GLOBAL
 * (APP_INTERCEPTOR) como el primero de la cadena, así envuelve también al
 * timeout/idempotency interceptors y mide la duración TOTAL del request.
 *
 * Los requests que terminan en excepción NO se loguean acá (se pisaría con
 * el log del `GlobalExceptionFilter`, que ya tiene el detalle del error);
 * este interceptor solo cubre el camino feliz.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request: any = context.switchToHttp().getRequest();
    const response: any = context.switchToHttp().getResponse();
    const start = request.startTime ?? Date.now();
    const requestId =
      request.requestId ?? request.headers?.['x-request-id'] ?? '-';
    const method = request.method;
    const path = request.originalUrl ?? request.url;

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - start;
        this.logger.log(
          `[${requestId}] ${method} ${path} ${response.statusCode} ${duration}ms`,
        );
      }),
    );
  }
}
