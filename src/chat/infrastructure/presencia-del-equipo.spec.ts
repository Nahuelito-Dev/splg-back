import type { Redis } from 'ioredis';
import {
  CLAVE_DE_PRESENCIA,
  PresenciaDelEquipo,
  VIGENCIA_MS,
} from './presencia-del-equipo';

/** Un Redis en memoria con lo justo: conjunto ordenado y `SET … GET`. */
function redisFalso() {
  const zset = new Map<string, number>();
  const claves = new Map<string, string>();
  const fake = {
    zadd: jest.fn((_clave: string, ...pares: Array<string | number>) => {
      for (let i = 0; i < pares.length; i += 2) {
        zset.set(String(pares[i + 1]), Number(pares[i]));
      }
      return Promise.resolve(pares.length / 2);
    }),
    zrem: jest.fn((_clave: string, m: string) =>
      Promise.resolve(zset.delete(m) ? 1 : 0),
    ),
    zremrangebyscore: jest.fn((_clave: string, _min: string, max: string) => {
      const tope = Number(max.replace('(', ''));
      for (const [m, p] of zset) if (p < tope) zset.delete(m);
      return Promise.resolve(0);
    }),
    zrangebyscore: jest.fn((_clave: string, min: number) =>
      Promise.resolve([...zset].filter(([, p]) => p >= min).map(([m]) => m)),
    ),
    set: jest.fn((clave: string, valor: string) => {
      const anterior = claves.get(clave) ?? null;
      claves.set(clave, valor);
      return Promise.resolve(anterior);
    }),
    disconnect: jest.fn(),
  };
  return { fake, zset, redis: fake as unknown as Redis };
}

describe('PresenciaDelEquipo (D-C26): conjunto en Redis con latido', () => {
  const T = 1_000_000;

  it('cuenta personas, no pestañas', async () => {
    const { redis } = redisFalso();
    const p = new PresenciaDelEquipo(redis);
    await p.marcar(
      [
        { userId: 'ana', socketId: 's1' },
        { userId: 'ana', socketId: 's2' },
        { userId: 'beto', socketId: 's3' },
      ],
      T,
    );
    expect(await p.personasConectadas(T)).toBe(2);
  });

  it('al desconectarse sale; si le queda otra pestaña, sigue contando', async () => {
    const { redis } = redisFalso();
    const p = new PresenciaDelEquipo(redis);
    await p.marcar(
      [
        { userId: 'ana', socketId: 's1' },
        { userId: 'ana', socketId: 's2' },
      ],
      T,
    );
    await p.quitar({ userId: 'ana', socketId: 's1' });
    expect(await p.personasConectadas(T)).toBe(1);
    await p.quitar({ userId: 'ana', socketId: 's2' });
    expect(await p.personasConectadas(T)).toBe(0);
  });

  it('si la instancia muere sin avisar, sus conexiones vencen sin latido y se limpian', async () => {
    const { redis, zset, fake } = redisFalso();
    const p = new PresenciaDelEquipo(redis);
    await p.marcar([{ userId: 'ana', socketId: 's1' }], T);
    expect(await p.personasConectadas(T + VIGENCIA_MS)).toBe(1);
    expect(await p.personasConectadas(T + VIGENCIA_MS + 1)).toBe(0);
    expect(zset.size).toBe(0);
    expect(fake.zremrangebyscore).toHaveBeenCalledWith(
      CLAVE_DE_PRESENCIA,
      '-inf',
      `(${T + 1}`,
    );
  });

  it('el latido renueva: una conexión renovada no vence', async () => {
    const { redis } = redisFalso();
    const p = new PresenciaDelEquipo(redis);
    await p.marcar([{ userId: 'ana', socketId: 's1' }], T);
    await p.marcar([{ userId: 'ana', socketId: 's1' }], T + VIGENCIA_MS);
    expect(await p.personasConectadas(T + VIGENCIA_MS + 10)).toBe(1);
  });

  it('marcar nada no toca Redis', async () => {
    const { redis, fake } = redisFalso();
    await new PresenciaDelEquipo(redis).marcar([], T);
    expect(fake.zadd).not.toHaveBeenCalled();
  });

  it('el estado avisado: dice que cambió sólo si es distinto al anterior', async () => {
    const { redis } = redisFalso();
    const p = new PresenciaDelEquipo(redis);
    expect(await p.cambioElEstado('a')).toBe(true);
    expect(await p.cambioElEstado('a')).toBe(false);
    expect(await p.cambioElEstado('b')).toBe(true);
  });

  it('cierra su conexión al apagar la aplicación', () => {
    const { redis, fake } = redisFalso();
    new PresenciaDelEquipo(redis).onApplicationShutdown();
    expect(fake.disconnect).toHaveBeenCalled();
  });
});
