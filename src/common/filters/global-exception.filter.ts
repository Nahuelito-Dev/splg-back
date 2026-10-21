import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ConflictException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import {
  BadRequestDomainError,
  ConflictDomainError,
  NotFoundDomainError,
} from '../errors/domain.error';
import {
  MENSAJE_SISTEMA_OCUPADO,
  MENSAJE_TEXTO_INVALIDO,
  esTextoInvalidoDeBase,
  esTimeoutDeBase,
  traducirRestriccionConocida,
} from '../errors/db-exceptions';
import type { Request } from 'express';

/**
 * Exception filter GLOBAL (observabilidad, C4): loguea toda excepción no
 * manejada con su `request-id` (correlación con `requestIdMiddleware` /
 * `LoggingInterceptor`), método, path, status y duración — y DESPUÉS delega
 * en `BaseExceptionFilter` para que la respuesta al cliente sea EXACTAMENTE
 * la misma que sin este filter (mismo shape `{statusCode, message, error}`).
 *
 * Extiende `BaseExceptionFilter` en vez de reimplementar el formateo de
 * respuesta: así no hay riesgo de romper el contrato de error que ya
 * consumen las apps (Flutter/React). Se registra vía `app.useGlobalFilters()`
 * en `main.ts` (no como APP_FILTER) porque necesita el `httpAdapter` real —
 * es el patrón que documenta Nest para "extending base exception filter".
 *
 * NO loguea el body/headers del request (podrían traer contraseñas, tokens,
 * datos de pago): solo método, path, status, request-id y el mensaje de la
 * excepción.
 */
@Catch()
export class GlobalExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    // Errores de DOMINIO (state machines, stock — dominio puro, sin
    // @nestjs/common, ver `common/errors/domain.error.ts`, P2-9): se convierten
    // acá a la MISMA HttpException que el código lanzaba antes de extraerlos a
    // `domain/errors/`, para que el status y el mensaje de la respuesta NO
    // cambien.
    exception = this.mapDomainError(exception);

    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request | undefined>();
    const header = request?.headers?.['x-request-id'];
    const requestId =
      request?.requestId ?? (typeof header === 'string' ? header : '-');
    const method = request?.method ?? '-';
    const path = request?.originalUrl ?? request?.url ?? '-';
    const duration = request?.startTime
      ? Date.now() - request.startTime
      : undefined;

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const message =
      exception instanceof HttpException
        ? exception.message
        : exception instanceof Error
          ? exception.message
          : 'Internal server error';

    const line = `[${requestId}] ${method} ${path} ${status} ${duration ?? '-'}ms — ${message}`;

    // 5xx = error real del servidor → stack trace. 4xx = error de cliente
    // (validación, not found, etc.) → una línea, sin ruido.
    if (status >= 500) {
      this.logger.error(
        line,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(line);
    }

    super.catch(exception, host);
  }

  /**
   * Convierte un error de DOMINIO (`BadRequestDomainError`/`NotFoundDomainError`/
   * `ConflictDomainError`)
   * a la `HttpException` equivalente, con el MISMO mensaje. Cualquier otra
   * excepción (incluidas las `HttpException` que el código sigue lanzando
   * directo) pasa sin tocar.
   */
  private mapDomainError(exception: unknown): unknown {
    if (exception instanceof NotFoundDomainError) {
      return new NotFoundException(exception.message);
    }
    if (exception instanceof BadRequestDomainError) {
      return new BadRequestException(exception.message);
    }
    if (exception instanceof ConflictDomainError) {
      return new ConflictException(exception.message);
    }
    // lock_timeout / statement_timeout de Postgres: la base está ocupada, no
    // rota. 503 con mensaje claro en vez de un 500 genérico.
    if (!(exception instanceof HttpException) && esTimeoutDeBase(exception)) {
      this.logger.warn(
        `Timeout de base de datos: ${exception instanceof Error ? exception.message : 'sin mensaje'}`,
      );
      return new ServiceUnavailableException(MENSAJE_SISTEMA_OCUPADO);
    }
    // Un texto que la base no puede guardar (NUL, bytes inválidos): dato
    // inválido del cliente, 400 en vez de un 500 sin explicación.
    if (
      !(exception instanceof HttpException) &&
      esTextoInvalidoDeBase(exception)
    ) {
      this.logger.warn(
        `Texto con caracteres no válidos: ${exception instanceof Error ? exception.message : 'sin mensaje'}`,
      );
      return new BadRequestException(MENSAJE_TEXTO_INVALIDO);
    }
    // Una regla de la base (CHECK, único, exclusión) que ningún servicio
    // alcanzó a traducir: 400/409 con el motivo en castellano.
    const restriccion = traducirRestriccionConocida(exception);
    if (restriccion) {
      this.logger.warn(`Regla de la base violada: ${restriccion.message}`);
      return restriccion;
    }
    return exception;
  }
}
