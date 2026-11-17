import {
  BadRequestDomainError,
  ConflictDomainError,
  NotFoundDomainError,
} from '../errors/domain.error';

/**
 * Un error que en HTTP sería un 4xx: una respuesta esperada (validación, no
 * existe, conflicto de estado), no una falla del sistema. No va a Sentry.
 *
 * Las excepciones HTTP de Nest se reconocen por su forma (`getStatus` y
 * `getResponse`), no por `instanceof`: este archivo lo carga la configuración
 * de Sentry antes que Nest, y cargar `@nestjs/common` ahí deja a Nest sin
 * instrumentar.
 */
export function esErrorEsperado(error: unknown): boolean {
  if (
    error instanceof BadRequestDomainError ||
    error instanceof NotFoundDomainError ||
    error instanceof ConflictDomainError
  ) {
    return true;
  }
  if (typeof error !== 'object' || error === null) return false;
  const { getStatus, getResponse } = error as {
    getStatus?: unknown;
    getResponse?: unknown;
  };
  if (typeof getStatus !== 'function' || typeof getResponse !== 'function') {
    return false;
  }
  const status: unknown = (getStatus as () => unknown).call(error);
  return typeof status === 'number' && status >= 400 && status < 500;
}
