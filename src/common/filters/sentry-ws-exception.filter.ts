import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseWsExceptionFilter, WsException } from '@nestjs/websockets';
import * as Sentry from '@sentry/nestjs';

/** Lo que el filtro lee del socket: la identidad que resolvió el handshake. */
interface SocketConIdentidad {
  nsp?: { name?: string };
  data?: {
    identidad?: { userId?: string; distributorId?: string | null };
  };
}

/**
 * Errores de los gateways de Socket.IO: los filtros globales de la app no
 * alcanzan a los gateways, así que cada uno lo declara con `@UseFilters`.
 * Manda a Sentry lo que no es una respuesta esperada (`WsException`, o un
 * `HttpException` 4xx) y después responde al socket igual que el filtro que
 * Nest usa por defecto.
 */
@Catch()
export class SentryWsExceptionFilter extends BaseWsExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    if (!SentryWsExceptionFilter.esEsperado(exception)) {
      const cliente = host.switchToWs().getClient<SocketConIdentidad>();
      Sentry.withScope((scope) => {
        const identidad = cliente?.data?.identidad;
        if (identidad?.userId) scope.setUser({ id: identidad.userId });
        if (identidad?.distributorId) {
          scope.setTag('distributor', identidad.distributorId);
        }
        if (cliente?.nsp?.name)
          scope.setTag('socket_namespace', cliente.nsp.name);
        Sentry.captureException(exception, {
          mechanism: { handled: false, type: 'auto.ws.nestjs.global_filter' },
        });
      });
    }
    super.catch(exception, host);
  }

  private static esEsperado(exception: unknown): boolean {
    return (
      exception instanceof WsException ||
      (exception instanceof HttpException && exception.getStatus() < 500)
    );
  }
}
