import type { Redis } from 'ioredis';
import { PresenciaDeLaBandeja } from './presencia-de-la-bandeja';
import { VIGENCIA_MS } from './presencia-del-equipo';

/** Un Redis en memoria con lo justo: conjuntos ordenados por clave y `SET … GET`. */
function redisFalso() {
  const zsets = new Map<string, Map<string, number>>();
  const claves = new Map<string, string>();
  const z = (k: string) => {
    if (!zsets.has(k)) zsets.set(k, new Map());
    return zsets.get(k) as Map<string, number>;
  };
  const fake = {
    zadd: jest.fn((clave: string, ...pares: Array<string | number>) => {
      for (let i = 0; i < pares.length; i += 2) {
        z(clave).set(String(pares[i + 1]), Number(pares[i]));
      }
      return Promise.resolve(pares.length / 2);
    }),
    zrem: jest.fn((clave: string, m: string) =>
      Promise.resolve(z(clave).delete(m) ? 1 : 0),
    ),
    zremrangebyscore: jest.fn((clave: string, _min: string, max: string) => {
      const tope = Number(max.replace('(', ''));
      for (const [m, p] of z(clave)) if (p < tope) z(clave).delete(m);
      return Promise.resolve(0);
    }),
    zrangebyscore: jest.fn((clave: string, min: number) =>
      Promise.resolve(
        [...z(clave)].filter(([, p]) => p >= min).map(([m]) => m),
      ),
    ),
    zrange: jest.fn((clave: string) =>
      Promise.resolve([...z(clave)].flatMap(([m, p]) => [m, String(p)])),
    ),
    expire: jest.fn(() => Promise.resolve(1)),
    set: jest.fn((clave: string, valor: string) => {
      const anterior = claves.get(clave) ?? null;
      claves.set(clave, valor);
      return Promise.resolve(anterior);
    }),
  };
  return { fake, zsets, redis: fake as unknown as Redis };
}

describe('PresenciaDeLaBandeja (8b): conexiones del equipo de cada empresa', () => {
  const T = 1_000_000;
  const ana = { distributorId: 'A', userId: 'ana', socketId: 's1' };
  const ana2 = { distributorId: 'A', userId: 'ana', socketId: 's2' };
  const beto = { distributorId: 'B', userId: 'beto', socketId: 's3' };

  it('cada empresa por su lado: B no ve a la gente de A', async () => {
    const { redis } = redisFalso();
    const p = new PresenciaDeLaBandeja(redis);
    await p.marcar([ana, beto], T);
    expect([...(await p.deLaEmpresa('A', T)).keys()]).toEqual(['ana']);
    expect([...(await p.deLaEmpresa('B', T)).keys()]).toEqual(['beto']);
  });

  it('conectada mientras le quede una pestaña; al cerrar la última queda «vista» a esa hora', async () => {
    const { redis } = redisFalso();
    const p = new PresenciaDeLaBandeja(redis);
    await p.marcar([ana, ana2], T);
    await p.quitar(ana, T + 1000);
    expect((await p.deLaEmpresa('A', T + 1000)).get('ana')).toEqual({
      conectado: true,
      vistoEn: T + 1000,
    });
    await p.quitar(ana2, T + 5000);
    expect((await p.deLaEmpresa('A', T + 6000)).get('ana')).toEqual({
      conectado: false,
      vistoEn: T + 5000,
    });
  });

  it('la conexión de una instancia caída (sin latido) vence sola y queda vista en su último latido', async () => {
    const { redis } = redisFalso();
    const p = new PresenciaDeLaBandeja(redis);
    await p.marcar([ana], T);
    expect((await p.deLaEmpresa('A', T + VIGENCIA_MS + 1)).get('ana')).toEqual({
      conectado: false,
      vistoEn: T,
    });
  });

  it('quien nunca se conectó no figura', async () => {
    const { redis } = redisFalso();
    const p = new PresenciaDeLaBandeja(redis);
    expect((await p.deLaEmpresa('A', T)).size).toBe(0);
    await p.marcar([], T);
    expect((await p.deLaEmpresa('A', T)).size).toBe(0);
  });

  it('el último estado avisado de cada persona: sólo dice «cambió» la primera vez', async () => {
    const { redis } = redisFalso();
    const p = new PresenciaDeLaBandeja(redis);
    expect(await p.cambioElEstado('A', 'ana', 'x')).toBe(true);
    expect(await p.cambioElEstado('A', 'ana', 'x')).toBe(false);
    expect(await p.cambioElEstado('A', 'ana', 'y')).toBe(true);
    expect(await p.cambioElEstado('B', 'ana', 'y')).toBe(true);
  });
});
