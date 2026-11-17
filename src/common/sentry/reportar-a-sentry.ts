import * as Sentry from '@sentry/nestjs';
import type { Request } from 'express';
import { errorMessage } from '../errors/error-message';
import { contextoDeSentry } from './contexto-de-sentry';
import { esErrorEsperado } from './errores-esperados';
import { FrenoDeErrores } from './freno-de-errores';

/**
 * Lo que la app manda a Sentry a mano. Sin `SENTRY_DSN` el SDK no está
 * inicializado y estas llamadas no hacen nada.
 */

/**
 * Un status que va a Sentry: sólo los 5xx. Los 4xx (validación, 401, 403,
 * 404, 409, 429) son respuestas esperadas, no errores del sistema.
 */
export function esErrorParaSentry(status: number): boolean {
  return status >= 500;
}

/**
 * Un error de request que terminó en 5xx, con el contexto de la request (el
 * error pudo saltar en un guard, antes que el interceptor que lo pone).
 */
export function reportarErrorDeRequest(
  error: unknown,
  request: Request | undefined,
): void {
  if (request) contextoDeSentry(request);
  Sentry.captureException(error, {
    mechanism: { handled: false, type: 'auto.http.nestjs.global_filter' },
  });
}

/** Dónde se atrapó un error de un proceso automático. */
export interface OrigenDelError {
  /** El proceso (`ProcessName`) de la corrida en curso, si la hay. */
  proceso: string | null;
  distribuidora: string | null;
  /** El error cortó la corrida entera (si no, falló una parte y el resto siguió). */
  fatal: boolean;
}

/** Un freno por proceso (la instancia de la API). */
const freno = new FrenoDeErrores();

/**
 * Un error que un proceso atrapó para seguir (y que si no se perdería en el
 * log): va con el proceso y la empresa como tags. No va si en HTTP sería un
 * 4xx, ni si el mismo error del mismo proceso ya salió en los últimos 10
 * minutos (`FrenoDeErrores`). Devuelve si lo mandó.
 */
export function reportarErrorAtrapado(
  error: unknown,
  origen: OrigenDelError,
  frenoDeErrores: FrenoDeErrores = freno,
): boolean {
  if (esErrorEsperado(error)) return false;
  if (!frenoDeErrores.pasa(origen.proceso, errorMessage(error))) return false;
  Sentry.withScope((scope) => {
    if (origen.proceso) scope.setTag('process', origen.proceso);
    if (origen.distribuidora) scope.setTag('distributor', origen.distribuidora);
    scope.setTag('process_fatal', origen.fatal ? 'true' : 'false');
    scope.setLevel(origen.fatal ? 'error' : 'warning');
    Sentry.captureException(error, {
      mechanism: { handled: true, type: 'splg.process_run' },
    });
  });
  return true;
}
