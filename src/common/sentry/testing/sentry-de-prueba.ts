import * as Sentry from '@sentry/nestjs';
import type { ErrorEvent, Log } from '@sentry/nestjs';
import { opcionesDeSentry } from '../../config/sentry.config';

/** Lo que habría salido hacia Sentry, ya pasado por los filtros de la app. */
export interface SalidaDeSentry {
  errores: ErrorEvent[];
  logs: Log[];
}

/**
 * Sólo para pruebas: inicializa el SDK real con la configuración de la app,
 * pero en vez de mandar a Sentry guarda lo que habría salido. Cerrar con
 * `Sentry.close()` al terminar.
 */
export function iniciarSentryDePrueba(): SalidaDeSentry {
  const salida: SalidaDeSentry = { errores: [], logs: [] };
  const opciones = opcionesDeSentry(
    { SENTRY_DSN: 'https://clave@o1.ingest.sentry.io/2', NODE_ENV: 'test' },
    '1.0.0',
  );
  Sentry.init({
    ...opciones,
    tracesSampleRate: 0,
    defaultIntegrations: false,
    integrations: [],
    beforeSend: (evento, hint) => {
      const limpio = opciones?.beforeSend?.(evento, hint);
      if (limpio && !('then' in limpio)) salida.errores.push(limpio);
      return null;
    },
    beforeSendLog: (log) => {
      const limpio = opciones?.beforeSendLog?.(log);
      if (limpio) salida.logs.push(limpio);
      return null;
    },
  });
  return salida;
}
