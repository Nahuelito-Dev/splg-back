import { applyDecorators } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { Idempotent } from '../../common/decorators/idempotent.decorator';

/**
 * `@Idempotent()` más la declaración OpenAPI del header `Idempotency-Key` como
 * requerido, para que los clientes generados lo envíen siempre. El 400 sin clave
 * lo da `exigirIdempotencyKey` en el handler.
 */
export const IdempotencyKeyObligatoria = () =>
  applyDecorators(
    Idempotent(),
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      description:
        'UUID v4 de la operación. Obligatoria: sin ella responde 400 (un reintento duplicaría el movimiento).',
      schema: { type: 'string', format: 'uuid' },
    }),
  );
