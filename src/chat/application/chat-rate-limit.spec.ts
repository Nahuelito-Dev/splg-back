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
      await expect(
        cupos.mensaje({
          ambito: 'dist-a',
          userId: 'u-1',
          clientMessageId: 'cmid-1',
        }),
      ).resolves.toBeUndefined();
    }
  });

  it('mensajes distintos sí lo consumen: el que pasa el tope es 429', async () => {
    const cupos = new ChatRateLimit(redisFalso() as unknown as RedisService);
    for (let i = 0; i < MENSAJES_POR_MINUTO; i++) {
      await cupos.mensaje({
        ambito: 'dist-a',
        userId: 'u-1',
        clientMessageId: `cmid-${i}`,
      });
    }
    await expect(
      cupos.mensaje({
        ambito: 'dist-a',
        userId: 'u-1',
        clientMessageId: 'cmid-extra',
      }),
    ).rejects.toMatchObject({
      status: 429,
    });
  });

  it('el cupo es por persona', async () => {
    const cupos = new ChatRateLimit(redisFalso() as unknown as RedisService);
    for (let i = 0; i < MENSAJES_POR_MINUTO; i++) {
      await cupos.mensaje({
        ambito: 'dist-a',
        userId: 'u-1',
        clientMessageId: `cmid-${i}`,
      });
    }
    await expect(
      cupos.mensaje({
        ambito: 'dist-a',
        userId: 'u-2',
        clientMessageId: 'cmid-0',
      }),
    ).resolves.toBeUndefined();
  });

  it('reintentar un mensaje que dio 429 vuelve a contar: no esquiva el tope', async () => {
    const cupos = new ChatRateLimit(redisFalso() as unknown as RedisService);
    for (let i = 0; i < MENSAJES_POR_MINUTO; i++) {
      await cupos.mensaje({
        ambito: 'dist-a',
        userId: 'u-1',
        clientMessageId: `cmid-${i}`,
      });
    }
    await expect(
      cupos.mensaje({
        ambito: 'dist-a',
        userId: 'u-1',
        clientMessageId: 'cmid-extra',
      }),
    ).rejects.toMatchObject({
      status: 429,
    });
    await expect(
      cupos.mensaje({
        ambito: 'dist-a',
        userId: 'u-1',
        clientMessageId: 'cmid-extra',
      }),
    ).rejects.toMatchObject({
      status: 429,
    });
  });

  it('dos pedidos simultáneos con el mismo id: el segundo no pasa sin contar', async () => {
    const redis = redisFalso();
    const cupos = new ChatRateLimit(redis as unknown as RedisService);
    // El primero quedó «en curso» (marcado y todavía sin confirmar).
    await redis.setIfAbsent('chat:cupo:cmid:dist-a:u-1:cmid-x');
    await expect(
      cupos.mensaje({
        ambito: 'dist-a',
        userId: 'u-1',
        clientMessageId: 'cmid-x',
      }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('con la marca aceptada, el reintento pasa sin consumir cupo', async () => {
    const redis = redisFalso();
    const cupos = new ChatRateLimit(redis as unknown as RedisService);
    await cupos.mensaje({
      ambito: 'dist-a',
      userId: 'u-1',
      clientMessageId: 'cmid-y',
    });
    expect(await redis.get('chat:cupo:cmid:dist-a:u-1:cmid-y')).toBe('ok');
    const antes = redis.incrWithExpire.mock.calls.length;
    await cupos.mensaje({
      ambito: 'dist-a',
      userId: 'u-1',
      clientMessageId: 'cmid-y',
    });
    expect(redis.incrWithExpire.mock.calls.length).toBe(antes);
  });

  it('la marca lleva la empresa: el mismo id en otra empresa es otro mensaje y cuenta', async () => {
    const redis = redisFalso();
    const cupos = new ChatRateLimit(redis as unknown as RedisService);
    await cupos.mensaje({
      ambito: 'dist-a',
      userId: 'u-1',
      clientMessageId: 'cmid-z',
    });
    const antes = redis.incrWithExpire.mock.calls.length;
    await cupos.mensaje({
      ambito: 'dist-b',
      userId: 'u-1',
      clientMessageId: 'cmid-z',
    });
    expect(redis.incrWithExpire.mock.calls.length).toBe(antes + 1);
    expect(await redis.get('chat:cupo:cmid:dist-b:u-1:cmid-z')).toBe('ok');
  });

  it('un envío en curso en una empresa no frena el mismo id en otra', async () => {
    const redis = redisFalso();
    const cupos = new ChatRateLimit(redis as unknown as RedisService);
    await redis.setIfAbsent('chat:cupo:cmid:dist-a:u-1:cmid-w');
    await expect(
      cupos.mensaje({
        ambito: 'dist-b',
        userId: 'u-1',
        clientMessageId: 'cmid-w',
      }),
    ).resolves.toBeUndefined();
  });
});
