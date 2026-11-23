import { COMPONENTES, Componente } from './componentes';
import { BLOQUE_MS } from './disponibilidad';
import {
  ClienteHistorial,
  HistorialRedisStore,
  VIGENCIA_SEG,
} from './historial.store';

type Resultado = [Error | null, unknown];

/** Redis en memoria con sólo lo que usa el store; permite inyectar fallos. */
class RedisFalso {
  readonly strings = new Map<string, string>();
  readonly hashes = new Map<string, Map<string, string>>();
  readonly ttl = new Map<string, number>();
  /** Comandos que fallan: devuelven error en su posición del pipeline. */
  fallan = new Set<string>();
  cerrado = false;

  on(): this {
    return this;
  }

  disconnect(): void {
    this.cerrado = true;
  }

  pipeline() {
    const ops: Array<() => Resultado> = [];
    const agregar = (nombre: string, fn: () => unknown) => {
      ops.push(() =>
        this.fallan.has(nombre)
          ? [new Error(`falla ${nombre}`), null]
          : [null, fn()],
      );
    };
    const p = {
      hsetnx: (clave: string, campo: string, valor: string) => {
        agregar('hsetnx', () => {
          const h = this.hashes.get(clave) ?? new Map<string, string>();
          this.hashes.set(clave, h);
          if (h.has(campo)) return 0;
          h.set(campo, valor);
          return 1;
        });
        return p;
      },
      expire: (clave: string, seg: number) => {
        agregar('expire', () => {
          this.ttl.set(clave, seg);
          return 1;
        });
        return p;
      },
      set: (clave: string, valor: string, modo: string) => {
        agregar('set', () => {
          if (modo === 'NX' && this.strings.has(clave)) return null;
          this.strings.set(clave, valor);
          return 'OK';
        });
        return p;
      },
      get: (clave: string) => {
        agregar('get', () => this.strings.get(clave) ?? null);
        return p;
      },
      hgetall: (clave: string) => {
        agregar('hgetall', () =>
          Object.fromEntries(this.hashes.get(clave) ?? new Map()),
        );
        return p;
      },
      exec: () => Promise.resolve(ops.map((op) => op())),
    };
    return p;
  }
}

const crear = (redis: RedisFalso) =>
  new HistorialRedisStore(redis as unknown as ClienteHistorial);

function muestra(ok: boolean): Record<Componente, boolean> {
  return Object.fromEntries(COMPONENTES.map((c) => [c, ok])) as Record<
    Componente,
    boolean
  >;
}

// 2026-11-22 15:00 en Argentina = bloque 180 del día.
const BLOQUE_180 = Date.parse('2026-11-22T18:00:00Z');
const AHORA = BLOQUE_180 + 2 * 60_000;

describe('HistorialRedisStore', () => {
  it('guarda un campo <componente>:<bloque> por componente en el hash del día, con vigencia', async () => {
    const redis = new RedisFalso();
    await crear(redis).registrar(BLOQUE_180, {
      ...muestra(true),
      storage: false,
    });
    const hash = redis.hashes.get('health:historial:2026-11-22');
    expect(Object.fromEntries(hash ?? [])).toEqual({
      'api:180': '1',
      'postgres:180': '1',
      'redis:180': '1',
      'memory_rss:180': '1',
      'storage:180': '0',
    });
    expect(redis.ttl.get('health:historial:2026-11-22')).toBe(VIGENCIA_SEG);
    expect(VIGENCIA_SEG).toBe(95 * 24 * 60 * 60);
    expect(redis.strings.get('health:historial:primera')).toBe(
      String(BLOQUE_180),
    );
  });

  it('tras un reinicio (instancia nueva) la primera muestra del bloque se conserva', async () => {
    const redis = new RedisFalso();
    await crear(redis).registrar(BLOQUE_180, muestra(true));
    // el proceso se reinicia y vuelve a muestrear el mismo bloque, ahora "caído"
    await crear(redis).registrar(BLOQUE_180, muestra(false));
    const leido = await crear(redis).leer(AHORA, 1);
    const delDia = leido.muestras.get('2026-11-22');
    expect(delDia?.get('postgres:180')).toBe(true);
    expect(delDia?.size).toBe(COMPONENTES.length);
  });

  it('la marca del primer registro no se pisa con muestras posteriores', async () => {
    const redis = new RedisFalso();
    const store = crear(redis);
    await store.registrar(BLOQUE_180, muestra(true));
    await store.registrar(BLOQUE_180 + BLOQUE_MS, muestra(true));
    expect((await store.leer(AHORA, 1)).primeraMuestra).toBe(BLOQUE_180);
  });

  it('leer devuelve días vacíos y primera null sin datos', async () => {
    const leido = await crear(new RedisFalso()).leer(AHORA, 3);
    expect(leido.primeraMuestra).toBeNull();
    expect([...leido.muestras.keys()]).toEqual([
      '2026-11-20',
      '2026-11-21',
      '2026-11-22',
    ]);
  });

  it('un fallo parcial del pipeline hace fallar registrar (el muestreo lo retiene) y el reintento completa sin pisar', async () => {
    const redis = new RedisFalso();
    const store = crear(redis);
    redis.fallan = new Set(['expire']);
    await expect(store.registrar(BLOQUE_180, muestra(true))).rejects.toThrow(
      'falla expire',
    );
    // los HSETNX alcanzaron a escribirse; el reintento no los pisa
    redis.fallan = new Set();
    await expect(
      store.registrar(BLOQUE_180, muestra(false)),
    ).resolves.toBeUndefined();
    const delDia = (await store.leer(AHORA, 1)).muestras.get('2026-11-22');
    expect(delDia?.get('redis:180')).toBe(true);
    expect(redis.ttl.get('health:historial:2026-11-22')).toBe(VIGENCIA_SEG);
  });

  it('un fallo al leer se propaga para que la página avise "sin historial"', async () => {
    const redis = new RedisFalso();
    redis.fallan = new Set(['hgetall']);
    await expect(crear(redis).leer(AHORA, 1)).rejects.toThrow('falla hgetall');
  });

  it('al apagar cierra la conexión', async () => {
    const redis = new RedisFalso();
    await crear(redis).onApplicationShutdown();
    expect(redis.cerrado).toBe(true);
  });
});
