import { ConsoleLogger, LogLevel } from '@nestjs/common';
import { ContextoDeTraza, prefijoDeTraza } from './contexto-de-traza';

/**
 * El logger de la app: el de Nest más la traza en curso. En texto antepone
 * `[t:<8 primeros>]` a cada línea; en JSON (`json: true`) agrega `traceId`.
 * Fuera de una traza (arranque, módulos) la línea sale como siempre.
 */
export class LoggerConTraza extends ConsoleLogger {
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
