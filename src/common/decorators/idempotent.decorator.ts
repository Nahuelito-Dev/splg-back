import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'idempotent';

/**
 * Marca un endpoint como idempotente. El IdempotencyInterceptor leerá
 * el header `Idempotency-Key` (UUID v4) y:
 *
 *   1. Si ya hay una respuesta cacheada para esa key → retorna la cacheada
 *      sin volver a ejecutar el handler.
 *   2. Si NO hay cache pero existe un lock activo → 409 Conflict
 *      (otro request con la misma key está en curso).
 *   3. Si no hay nada → adquiere lock, ejecuta handler, cachea response
 *      por 24h.
 *
 * Solo se cachean respuestas 2xx. Errores se propagan sin cachear,
 * permitiendo retry posterior con la misma key.
 *
 * Uso:
 *   @Post()
 *   @Idempotent()
 *   async create(...) { ... }
 *
 * Si el cliente NO envía el header, el handler se ejecuta normalmente
 * (no se aplica idempotencia). Esto mantiene backward compat.
 */
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true);
