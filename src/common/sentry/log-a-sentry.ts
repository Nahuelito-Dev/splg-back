import * as Sentry from '@sentry/nestjs';

/** Una línea de log que también va a Sentry Logs: sólo `error`. */
export type NivelParaSentry = 'error';

/** El stack que Nest pasa como parámetro de `logger.error(mensaje, stack, contexto)`. */
function esStack(valor: string): boolean {
  return /\n\s+at\s/.test(valor);
}

function comoTexto(mensaje: unknown): string {
  if (typeof mensaje === 'string') return mensaje;
  if (mensaje instanceof Error) return mensaje.message;
  try {
    return JSON.stringify(mensaje) ?? String(mensaje);
  } catch {
    return String(mensaje);
  }
}

/**
 * Manda una línea del logger de Nest a Sentry Logs, con su contexto (`[Clase]`)
 * y la traza de la app (`[t:<traza>]`) como atributos. Los parámetros son los
 * que recibe el logger: el último texto que no es un stack es el contexto.
 * Sin Sentry inicializado no hace nada.
 */
export function logASentry(
  nivel: NivelParaSentry,
  mensaje: unknown,
  parametros: readonly unknown[],
  traceId: string | null | undefined,
): void {
  const ultimo = parametros[parametros.length - 1];
  const contexto =
    typeof ultimo === 'string' && !esStack(ultimo) ? ultimo : undefined;
  const atributos: Record<string, string> = {};
  if (contexto) atributos.context = contexto;
  if (traceId) atributos.app_trace_id = traceId;
  Sentry.logger[nivel](comoTexto(mensaje), atributos);
}
