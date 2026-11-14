import { AsyncLocalStorage } from 'async_hooks';

/** Quién y desde dónde hace el request en curso. */
export interface AuditContext {
  userId: string | null;
  ip: string | null;
  distributorId: string | null;
  /**
   * La request es del modo soporte: `ActorEnLaBase` abre cada transacción en
   * sólo lectura y rechaza las escrituras sueltas (segunda capa, después del
   * `AlcanceGuard`); `S3Service` no firma sin el alcance `files` y nunca más
   * allá del fin de la sesión.
   */
  soporte?: { alcance: readonly string[]; vence: Date };
}

/**
 * El contexto del request llega a la capa de datos sin pasar por parámetros:
 * lo abre `AuditContextInterceptor` y lo lee el subscriber. Fuera de un
 * request (crons, seeds, listeners que arrancan solos) no hay contexto y el
 * usuario queda en null.
 */
export const auditContext = new AsyncLocalStorage<AuditContext>();
