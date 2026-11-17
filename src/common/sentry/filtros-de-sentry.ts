import type {
  Breadcrumb,
  ErrorEvent,
  Event,
  EventHint,
  Log,
  NodeOptions,
  User,
} from '@sentry/nestjs';
import { limpiarUrl, limpiarValor, taparEnTexto } from './datos-sensibles';
import { esErrorEsperado } from './errores-esperados';

/**
 * Los `beforeSend*` de `Sentry.init`: lo último que pasa antes de que un
 * evento, un log o un span salga hacia Sentry. Ver `datos-sensibles.ts`.
 */

/** El span tal como lo recibe `beforeSendSpan` (trazas en modo `stream`). */
type SpanDeSentry = Parameters<NonNullable<NodeOptions['beforeSendSpan']>>[0];

/**
 * Niveles de log que van a Sentry; el resto se queda en la consola. `warn` no:
 * el filtro global loguea cada 4xx como `warn` (una línea por request).
 */
const NIVELES_DE_LOG: ReadonlySet<string> = new Set([
  'error',
  'fatal',
  'critical',
]);

function comoRegistro(valor: unknown): Record<string, unknown> | undefined {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : undefined;
}

function limpiarRegistro<T>(valor: T): T {
  // `limpiarValor` conserva la forma (objeto → objeto, arreglo → arreglo).
  return limpiarValor(valor) as T;
}

/** Del usuario sólo sale el id: nada de correo, nombre ni IP. */
function soloId(usuario: User | undefined): User | undefined {
  if (!usuario) return undefined;
  return usuario.id === undefined ? undefined : { id: usuario.id };
}

function limpiarMigas(
  migas: Breadcrumb[] | undefined,
): Breadcrumb[] | undefined {
  return migas?.map((miga) => ({
    ...miga,
    message: miga.message ? taparEnTexto(miga.message) : miga.message,
    data: miga.data ? limpiarRegistro(miga.data) : miga.data,
  }));
}

/** Un evento (error o transacción) sin datos personales ni secretos. */
export function limpiarEvento<T extends Event>(evento: T): T {
  const limpio: T = { ...evento };
  if (evento.request) {
    // Del request sólo salen el método, la URL sin la consulta y los
    // encabezados limpios: nunca el cuerpo (un chat, un CBU, un documento,
    // coordenadas…), la consulta, las cookies ni el entorno.
    const request = { ...evento.request };
    delete request.data;
    delete request.query_string;
    delete request.cookies;
    delete request.env;
    if (request.headers) request.headers = limpiarRegistro(request.headers);
    if (request.url) request.url = limpiarUrl(request.url);
    limpio.request = request;
  }
  if (evento.message) limpio.message = taparEnTexto(evento.message);
  if (evento.logentry?.message) {
    limpio.logentry = {
      ...evento.logentry,
      message: taparEnTexto(evento.logentry.message),
    };
  }
  if (evento.exception?.values) {
    limpio.exception = {
      ...evento.exception,
      values: evento.exception.values.map((e) => ({
        ...e,
        value: e.value ? taparEnTexto(e.value) : e.value,
      })),
    };
  }
  if (evento.user) limpio.user = soloId(evento.user);
  if (evento.extra) limpio.extra = limpiarRegistro(evento.extra);
  if (evento.contexts) limpio.contexts = limpiarRegistro(evento.contexts);
  if (evento.tags) limpio.tags = limpiarRegistro(evento.tags);
  if (evento.breadcrumbs) limpio.breadcrumbs = limpiarMigas(evento.breadcrumbs);
  return limpio;
}

/**
 * `beforeSend`: los errores. Un error que en HTTP sería un 4xx no sale, venga
 * de donde venga (también los que el SDK atrapa solo en un `@OnEvent`).
 */
export function antesDeEnviarError(
  evento: ErrorEvent,
  hint?: EventHint,
): ErrorEvent | null {
  if (hint && esErrorEsperado(hint.originalException)) return null;
  return limpiarEvento(evento);
}

/** `beforeSendLog`: sólo `error` (y `fatal`), y sin datos personales. */
export function antesDeEnviarLog(log: Log): Log | null {
  if (!NIVELES_DE_LOG.has(log.level)) return null;
  const atributos = comoRegistro(log.attributes);
  return {
    ...log,
    message:
      typeof log.message === 'string' ? taparEnTexto(log.message) : log.message,
    attributes: atributos ? limpiarRegistro(atributos) : log.attributes,
  };
}

/** `beforeSendSpan`: los atributos de las trazas (encabezados, URLs). */
export function antesDeEnviarSpan(span: SpanDeSentry): SpanDeSentry {
  return { ...span, attributes: limpiarRegistro(span.attributes) };
}
