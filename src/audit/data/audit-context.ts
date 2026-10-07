import { AsyncLocalStorage } from 'async_hooks';

/** Quién y desde dónde hace el request en curso. */
export interface AuditContext {
  userId: string | null;
  ip: string | null;
  distributorId: string | null;
}

/**
 * El contexto del request llega a la capa de datos sin pasar por parámetros:
 * lo abre `AuditContextInterceptor` y lo lee el subscriber. Fuera de un
 * request (crons, seeds, listeners que arrancan solos) no hay contexto y el
 * usuario queda en null.
 */
export const auditContext = new AsyncLocalStorage<AuditContext>();
