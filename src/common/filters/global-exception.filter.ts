import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ConflictException,
  HttpException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { GqlArgumentsHost, type GqlContextType } from '@nestjs/graphql';
import {
  BadRequestDomainError,
  ConflictDomainError,
  detalleDe,
  DomainError,
  NotFoundDomainError,
} from '../errors/domain.error';
import { conCodigo } from '../errors/con-codigo';
import { soloLecturaDeSoporte } from '../errors/soporte';
import {
  codigoSqlDelError,
  MENSAJE_SISTEMA_OCUPADO,
  MENSAJE_TEXTO_DEMASIADO_LARGO,
  MENSAJE_TEXTO_INVALIDO,
  esTextoDemasiadoLargoDeBase,
  esTextoInvalidoDeBase,
  esTimeoutDeBase,
  traducirRestriccionConocida,
} from '../errors/db-exceptions';
import { traducirExcepcion } from '../validation/traducir-excepcion';
import {
  esErrorParaSentry,
  reportarErrorDeRequest,
} from '../sentry/reportar-a-sentry';
import type { Request } from 'express';
import type { ContextoGraphql } from '../contexto/request-del-contexto';

/** `read_only_sql_transaction`: una escritura en una transacción de sólo lectura. */
const TRANSACCION_DE_SOLO_LECTURA = '25006';

/** La excepción HTTP de un error de dominio, con su `code` si lo trae. */
function conCodigoSiTiene<T extends HttpException>(
  Clase: new (respuesta: object | string) => T,
  status: number,
  error: DomainError,
): T {
  return error.code
    ? conCodigo(Clase, status, error.message, error.code)
    : new Clase(error.message);
}

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
 *
 * En un resolver de GraphQL no hay respuesta HTTP que escribir: se devuelve la
 * excepción ya traducida y Apollo la arma como error de GraphQL (ver
 * `formatearErrorGraphql`), con el mismo texto y `code` que en REST.
 */
@Catch()
export class GlobalExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): HttpException | undefined {
    // Errores de DOMINIO (state machines, stock — dominio puro, sin
    // @nestjs/common, ver `common/errors/domain.error.ts`, P2-9): se convierten
    // acá a la MISMA HttpException que el código lanzaba antes de extraerlos a
    // `domain/errors/`, para que el status y el mensaje de la respuesta NO
    // cambien.
    const interno = detalleDe(exception);
    const detalle = interno ? ` (${interno})` : '';
    const original = exception;
    exception = this.mapDomainError(exception);

    const graphql = host.getType<GqlContextType>() === 'graphql';
    const request = graphql
      ? GqlArgumentsHost.create(host).getContext<ContextoGraphql | undefined>()
          ?.req
      : host.switchToHttp().getRequest<Request | undefined>();
    const header = request?.headers?.['x-request-id'];
    const requestId =
      request?.requestId ?? (typeof header === 'string' ? header : '-');
    const method = request?.method ?? '-';
    const path = request?.originalUrl ?? request?.url ?? '-';
    const duration = request?.startTime
      ? Date.now() - request.startTime
      : undefined;

    // El status sale de la excepción ya traducida: un error 4xx crudo (body-parser,
    // http-errors) no se loguea como 5xx. El mensaje y el stack son los originales.
    const traducida = traducirExcepcion(exception);
    const status = traducida.getStatus();
    const message =
      exception instanceof Error ? exception.message : 'Internal server error';

    const line = `[${requestId}] ${method} ${path} ${status} ${duration ?? '-'}ms — ${message}${detalle}`;

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

    // A Sentry sólo los 5xx, con el error original (no la traducción).
    if (esErrorParaSentry(status)) reportarErrorDeRequest(original, request);

    if (graphql) return traducida;
    super.catch(traducida, host);
    return undefined;
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
      return conCodigoSiTiene(NotFoundException, 404, exception);
    }
    if (exception instanceof BadRequestDomainError) {
      return conCodigoSiTiene(BadRequestException, 400, exception);
    }
    if (exception instanceof ConflictDomainError) {
      return conCodigoSiTiene(ConflictException, 409, exception);
    }
    // Una escritura dentro de una transacción de sólo lectura: sólo la abre el
    // modo soporte (`ActorEnLaBase`), así que es un 403 del modo, no un 500.
    if (
      !(exception instanceof HttpException) &&
      codigoSqlDelError(exception) === TRANSACCION_DE_SOLO_LECTURA
    ) {
      return soloLecturaDeSoporte();
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
    // Un texto más largo que su columna (22001): dato inválido del cliente.
    if (
      !(exception instanceof HttpException) &&
      esTextoDemasiadoLargoDeBase(exception)
    ) {
      this.logger.warn(
        `Texto más largo que la columna: ${exception instanceof Error ? exception.message : 'sin mensaje'}`,
      );
      return new BadRequestException(MENSAJE_TEXTO_DEMASIADO_LARGO);
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
