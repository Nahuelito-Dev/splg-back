import { SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiUnprocessableEntityResponse } from '@nestjs/swagger';

export const IDEMPOTENT_KEY = 'idempotent';

/**
 * Marca las rutas multipart: la idempotencia corre DESPUÉS de multer (que es
 * interceptor de método), porque antes `request.file` y `request.body` todavía
 * no existen y no se puede comparar el archivo. El interceptor global las
 * saltea y las atiende `IdempotencyDespuesDeMulterInterceptor`.
 */
export const IDEMPOTENT_DESPUES_DE_MULTER_KEY = 'idempotentDespuesDeMulter';

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
 * La misma key con otro body (hash SHA-256 del JSON con claves ordenadas)
 * responde 422: la key identifica una operación y sólo esa.
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
export const Idempotent = () =>
  applyDecorators(
    SetMetadata(IDEMPOTENT_KEY, true),
    ApiUnprocessableEntityResponse({
      description:
        'La `Idempotency-Key` ya se usó con otro body. Revisá si la operación anterior se registró antes de reintentar.',
    }),
  );
