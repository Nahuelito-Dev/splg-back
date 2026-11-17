import { ConsoleLogger, LogLevel } from '@nestjs/common';
import { ContextoDeTraza, prefijoDeTraza } from './contexto-de-traza';
import { logASentry } from '../sentry/log-a-sentry';

/**
 * El logger de la app: el de Nest más la traza en curso. En texto antepone
 * `[t:<8 primeros>]` a cada línea; en JSON (`json: true`) agrega `traceId`.
 * Fuera de una traza (arranque, módulos) la línea sale como siempre.
 * Las líneas `error` además van a Sentry Logs.
 */
export class LoggerConTraza extends ConsoleLogger {
  /** `error` también va a Sentry Logs (el resto, sólo a la consola). */
  error(message: unknown, ...optionalParams: unknown[]): void {
    super.error(message, ...optionalParams);
    if (this.isLevelEnabled('error')) {
      logASentry(
        'error',
        message,
        optionalParams,
        ContextoDeTraza.traceIdActual(),
      );
    }
  }

  protected formatMessage(
    logLevel: LogLevel,
    message: unknown,
    pidMessage: string,
    formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string,
  ): string {
    const traceId = ContextoDeTraza.traceIdActual();
    const conTraza =
      traceId && typeof message === 'string'
        ? `${prefijoDeTraza(traceId)} ${message}`
        : message;
    return super.formatMessage(
      logLevel,
      conTraza,
      pidMessage,
      formattedLogLevel,
      contextMessage,
      timestampDiff,
    );
  }

  protected getJsonLogObject(
    message: unknown,
    options: {
      context: string;
      logLevel: LogLevel;
      writeStreamType?: 'stdout' | 'stderr';
      errorStack?: unknown;
    },
  ): {
    level: LogLevel;
    pid: number;
    timestamp: number;
    message: unknown;
    context?: string;
    stack?: unknown;
    traceId?: string;
  } {
    const objeto = super.getJsonLogObject(message, options);
    const traceId = ContextoDeTraza.traceIdActual();
    return traceId ? { ...objeto, traceId } : objeto;
  }
}
