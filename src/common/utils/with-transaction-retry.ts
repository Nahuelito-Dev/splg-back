import { Logger } from '@nestjs/common';

/**
 * Códigos de error de PostgreSQL que justifican reintento:
 * - 40P01: deadlock_detected
 * - 40001: serialization_failure (REPEATABLE READ o SERIALIZABLE)
 * Otros errores se propagan inmediatamente sin reintento.
 */
const RETRYABLE_PG_CODES = new Set(['40P01', '40001']);

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 50;

export interface TransactionRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  context?: string;
}

/**
 * Ejecuta una función dentro de un retry loop con backoff exponencial + jitter,
 * pensado para operaciones transaccionales que pueden fallar por contención
 * (deadlock o serialization failure).
 *
 * Importante: la función pasada debe ser idempotente respecto a errores retryables,
 * típicamente porque crea su propio QueryRunner y hace rollback en catch.
 */
export async function withTransactionRetry<T>(
  fn: () => Promise<T>,
  options: TransactionRetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    context = 'transaction',
  } = options;

  const logger = new Logger('withTransactionRetry');
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      const code: string | undefined = error?.code ?? error?.driverError?.code;
      const isRetryable = code && RETRYABLE_PG_CODES.has(code);

      if (!isRetryable || attempt === maxAttempts) {
        throw error;
      }

      // Exponential backoff with jitter: ~50ms, ~100ms, ~200ms (+/- 50%)
      const delay = baseDelayMs * 2 ** (attempt - 1);
      const jitter = delay * (Math.random() * 0.5 + 0.5);
      logger.warn(
        `[${context}] Retry ${attempt}/${maxAttempts - 1} after ${code} (sleep ${Math.round(jitter)}ms)`,
      );
      await new Promise((r) => setTimeout(r, jitter));
    }
  }

  throw lastError;
}
