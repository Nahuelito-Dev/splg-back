import { randomUUID } from 'crypto';
import request from 'supertest';
import type { Server } from 'http';

type Agente = ReturnType<typeof request>;

/**
 * Un cliente que se porta como el panel: cada `POST` y `PATCH` lleva su propio
 * `Idempotency-Key` nuevo. Las escrituras de stock y compras lo exigen (400 sin
 * él). Una prueba que necesite repetir una clave la pisa con
 * `.set('Idempotency-Key', clave)` y una que quiera mandar sin clave usa
 * `.unset('Idempotency-Key')`.
 */
export function conIdempotencia(servidor: Server): Agente {
  const agente = request(servidor);
  const conClave =
    (metodo: 'post' | 'patch') =>
    (url: string): request.Test =>
      agente[metodo](url).set('Idempotency-Key', randomUUID());
  return new Proxy(agente, {
    get(destino, propiedad, receptor) {
      if (propiedad === 'post') return conClave('post');
      if (propiedad === 'patch') return conClave('patch');
      return Reflect.get(destino, propiedad, receptor) as unknown;
    },
  });
}
