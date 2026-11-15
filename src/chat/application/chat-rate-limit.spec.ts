import type { RedisService } from '../../redis/redis.service';
import { ChatRateLimit, MENSAJES_POR_MINUTO } from './chat-rate-limit';

/** Redis en memoria: contadores y claves «una sola vez». */
function redisFalso() {
  const contadores = new Map<string, number>();
  const claves = new Map<string, string>();
  return {
    incrWithExpire: jest.fn((clave: string) => {
      const n = (contadores.get(clave) ?? 0) + 1;
      contadores.set(clave, n);
      return Promise.resolve(n);
    }),
    get: jest.fn((clave: string) => Promise.resolve(claves.get(clave) ?? null)),
    setex: jest.fn((clave: string, _ttl: number, valor: string) => {
      claves.set(clave, valor);
      return Promise.resolve();
    }),
    del: jest.fn((clave: string) => {
      claves.delete(clave);
      return Promise.resolve();
    }),
    setIfAbsent: jest.fn((clave: string) => {
      if (claves.has(clave)) return Promise.resolve(false);
      claves.set(clave, '1');
      return Promise.resolve(true);
    }),
  };
}

describe('ChatRateLimit', () => {
  it('reintentar el mismo mensaje no consume cupo: nunca da 429', async () => {
    const cupos = new ChatRateLimit(redisFalso() as unknown as RedisService);
    for (let i = 0; i < MENSAJES_POR_MINUTO * 2; i++) {
      await expect(cupos.mensaje('u-1', 'cmid-1')).resolves.toBeUndefined();
    }
  });

  it('mensajes distintos sí lo consumen: el que pasa el tope es 429', async () => {
    const cupos = new ChatRateLimit(redisFalso() as unknown as RedisService);
    for (let i = 0; i < MENSAJES_POR_MINUTO; i++) {
      await cupos.mensaje('u-1', `cmid-${i}`);
    }
    await expect(cupos.mensaje('u-1', 'cmid-extra')).rejects.toMatchObject({
      status: 429,
    });
  });

  it('el cupo es por persona', async () => {
    const cupos = new ChatRateLimit(redisFalso() as unknown as RedisService);
    for (let i = 0; i < MENSAJES_POR_MINUTO; i++) {
      await cupos.mensaje('u-1', `cmid-${i}`);
    }
    await expect(cupos.mensaje('u-2', 'cmid-0')).resolves.toBeUndefined();
  });

  it('reintentar un mensaje que dio 429 vuelve a contar: no esquiva el tope', async () => {
    const cupos = new ChatRateLimit(redisFalso() as unknown as RedisService);
    for (let i = 0; i < MENSAJES_POR_MINUTO; i++) {
      await cupos.mensaje('u-1', `cmid-${i}`);
    }
    await expect(cupos.mensaje('u-1', 'cmid-extra')).rejects.toMatchObject({
      status: 429,
    });
    await expect(cupos.mensaje('u-1', 'cmid-extra')).rejects.toMatchObject({
      status: 429,
    });
  });

  it('dos pedidos simultáneos con el mismo id: el segundo no pasa sin contar', async () => {
    const redis = redisFalso();
    const cupos = new ChatRateLimit(redis as unknown as RedisService);
    // El primero quedó «en curso» (marcado y todavía sin confirmar).
    await redis.setIfAbsent('chat:cupo:cmid:u-1:cmid-x');
    await expect(cupos.mensaje('u-1', 'cmid-x')).rejects.toMatchObject({
      status: 429,
    });
  });

  it('con la marca aceptada, el reintento pasa sin consumir cupo', async () => {
    const redis = redisFalso();
    const cupos = new ChatRateLimit(redis as unknown as RedisService);
    await cupos.mensaje('u-1', 'cmid-y');
    expect(await redis.get('chat:cupo:cmid:u-1:cmid-y')).toBe('ok');
    const antes = redis.incrWithExpire.mock.calls.length;
    await cupos.mensaje('u-1', 'cmid-y');
    expect(redis.incrWithExpire.mock.calls.length).toBe(antes);
  });
});
