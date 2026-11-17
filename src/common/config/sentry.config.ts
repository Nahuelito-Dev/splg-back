import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Sentry from '@sentry/nestjs';
import type { NodeOptions } from '@sentry/nestjs';
import {
  antesDeEnviarError,
  antesDeEnviarLog,
  antesDeEnviarSpan,
} from '../sentry/filtros-de-sentry';

/**
 * Configuración de Sentry (proyecto `splg-server`). La usa `src/instrument.ts`,
 * que se importa antes que cualquier otra cosa en `main.ts`: por eso este
 * archivo no importa nada de `@nestjs/*` (cargarlo antes del `init` deja a
 * Nest sin instrumentar).
 *
 * Sin `SENTRY_DSN` no se inicializa nada: los tests, el CI y quien no tenga el
 * DSN siguen igual que siempre.
 */

/**
 * Las variables de entorno. Sólo se leen `SENTRY_DSN`, `SENTRY_ENVIRONMENT`,
 * `SENTRY_RELEASE`, `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_MONITOR_CRONS` y
 * `NODE_ENV`.
 */
export type EntornoDeSentry = Readonly<Record<string, string | undefined>>;

/** Proporción de trazas fuera de desarrollo (en desarrollo, todas). */
const MUESTREO_DE_TRAZAS = 0.1;

function valor(texto: string | undefined): string | undefined {
  const limpio = texto?.trim();
  return limpio ? limpio : undefined;
}

/** `SENTRY_TRACES_SAMPLE_RATE` si es un número entre 0 y 1; si no, el de cada entorno. */
export function muestreoDeTrazas(
  texto: string | undefined,
  entorno: string,
): number {
  const numero = Number(valor(texto) ?? Number.NaN);
  if (Number.isFinite(numero) && numero >= 0 && numero <= 1) return numero;
  return entorno === 'development' ? 1 : MUESTREO_DE_TRAZAS;
}

/**
 * Check-ins de cada `@Cron` (un monitor por tarea, se cobran aparte): sólo con
 * `SENTRY_MONITOR_CRONS=true`. Los errores de los `@Cron` se mandan igual.
 */
export function monitorearCrons(env: EntornoDeSentry): boolean {
  return valor(env.SENTRY_MONITOR_CRONS)?.toLowerCase() === 'true';
}

/** La versión de `package.json` (en `dist/` y en `src/` queda un nivel arriba). */
export function versionDelPaquete(
  ruta = join(__dirname, '..', '..', '..', 'package.json'),
): string {
  try {
    const paquete = JSON.parse(readFileSync(ruta, 'utf8')) as {
      version?: unknown;
    };
    return typeof paquete.version === 'string'
      ? paquete.version
      : 'sin-version';
  } catch {
    return 'sin-version';
  }
}

/** Las opciones de `Sentry.init`, o `null` si no hay DSN. */
export function opcionesDeSentry(
  env: EntornoDeSentry,
  version: string = versionDelPaquete(),
): NodeOptions | null {
  const dsn = valor(env.SENTRY_DSN);
  if (!dsn) return null;
  const environment =
    valor(env.SENTRY_ENVIRONMENT) ?? valor(env.NODE_ENV) ?? 'development';
  return {
    dsn,
    environment,
    release: valor(env.SENTRY_RELEASE) ?? `splg-server@${version}`,
    tracesSampleRate: muestreoDeTrazas(
      env.SENTRY_TRACES_SAMPLE_RATE,
      environment,
    ),
    integrations: [
      Sentry.nestIntegration({ monitorCronJobs: monitorearCrons(env) }),
    ],
    // Lo que el SDK junta solo: nada que identifique a la persona. Ningún
    // cuerpo HTTP (tampoco los multipart de los adjuntos) ni la consulta de
    // las URLs: ninguna lista de campos alcanza a cubrir todo lo personal que
    // puede viajar ahí. El usuario (sólo su id) lo pone `contextoDeSentry`.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: {
        request: { deny: ['x-support-session', 'forwarded', '-ip'] },
        response: false,
      },
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      genAI: { inputs: false, outputs: false },
    },
    beforeSend: antesDeEnviarError,
    beforeSendLog: antesDeEnviarLog,
    beforeSendSpan: antesDeEnviarSpan,
  };
}

/**
 * Inicializa Sentry si hay DSN. Devuelve si lo hizo. `init` se recibe para
 * poder probarlo sin mandar nada.
 */
export function iniciarSentry(
  env: EntornoDeSentry = process.env,
  init: (opciones: NodeOptions) => unknown = Sentry.init,
): boolean {
  const opciones = opcionesDeSentry(env);
  if (!opciones) return false;
  init(opciones);
  return true;
}
