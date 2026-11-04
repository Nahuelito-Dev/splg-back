import { ExecutionContext, UnprocessableEntityException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import {
  IdempotencyDespuesDeMulterInterceptor,
  IdempotencyInterceptor,
  MENSAJE_CLAVE_OTROS_DATOS,
  hashDeBody,
} from './idempotency.interceptor';
import { marcarRespuestaIncompleta } from './respuesta-incompleta';

const KEY = '7a1b2c3d-1111-4222-8333-444455556666';

interface Pedido {
  userId?: string;
  distributorId?: string | null;
  archivo?: Buffer;
  method?: string;
  route: string;
  params?: Record<string, string>;
  body?: unknown;
}

describe('IdempotencyInterceptor', () => {
  let store: Map<string, string>;
  let interceptor: IdempotencyInterceptor;
  let lockOcupado: boolean;
  let multipart: boolean;
  let reflector: Reflector;
  let redisParaMultipart: unknown;
  let redisMock: { del: jest.Mock; withLock: jest.Mock };

  beforeEach(() => {
    store = new Map();
    lockOcupado = false;
    multipart = false;
    const redis = {
      get: jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
      setex: jest.fn((k: string, _t: number, v: string) => {
        store.set(k, v);
        return Promise.resolve();
      }),
      del: jest.fn((k: string) => {
        store.delete(k);
        return Promise.resolve();
      }),
      withLock: jest.fn(async (_k: string, _t: number, fn: () => unknown) =>
        lockOcupado
          ? { obtenido: false }
          : { obtenido: true, valor: await fn() },
      ),
    };
    redisMock = redis;
    reflector = {
      getAllAndOverride: jest.fn((clave: string) =>
        clave === 'idempotentDespuesDeMulter' ? multipart : true,
      ),
    } as unknown as Reflector;
    redisParaMultipart = redis;
    interceptor = new IdempotencyInterceptor(redis as never, reflector);
  });

  const ctx = (p: Pedido): ExecutionContext =>
    ({
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'idempotency-key': KEY },
          method: p.method ?? 'PATCH',
          route: { path: p.route },
          path: p.route,
          params: p.params ?? { id: 'o1' },
          body: p.body,
          user: { user_id: p.userId ?? 'u1' },
          distributorId: p.distributorId,
          file: p.archivo ? { buffer: p.archivo } : undefined,
        }),
      }),
    }) as unknown as ExecutionContext;

  const run = async (p: Pedido, respuesta: string) => {
    const handler = jest.fn(() => of(respuesta));
    const out = await interceptor.intercept(ctx(p), { handle: handler });
    return {
      body: await lastValueFrom(out),
      ejecutado: handler.mock.calls.length,
    };
  };

  describe('respuesta incompleta (falló la relectura tras confirmar)', () => {
    const ttlGuardado = (): number => {
      const llamada = (
        redisMock as unknown as { setex: jest.Mock }
      ).setex.mock.calls.at(-1) as [string, number, string];
      return llamada[1];
    };

    it('una respuesta normal se guarda 24 h', async () => {
      await run({ route: '/orders/:id/assign' }, 'completa');
      expect(ttlGuardado()).toBe(24 * 60 * 60);
    });

    it('si el handler la marca incompleta, se guarda 5 minutos y el reintento inmediato no repite la operación', async () => {
      const handler = jest.fn(() => {
        marcarRespuestaIncompleta();
        return of('a medias');
      });
      const out = await interceptor.intercept(ctx({ route: '/orders' }), {
        handle: handler,
      });
      await lastValueFrom(out);
      expect(ttlGuardado()).toBe(5 * 60);
      const r = await run({ route: '/orders' }, 'otra');
      expect(r.body).toBe('a medias');
      expect(r.ejecutado).toBe(0);
    });

    it('la marca de un request no contamina al siguiente', async () => {
      const marca = jest.fn(() => {
        marcarRespuestaIncompleta();
        return of('a medias');
      });
      await lastValueFrom(
        await interceptor.intercept(ctx({ route: '/a' }), { handle: marca }),
      );
      await run({ route: '/b' }, 'completa');
      expect(ttlGuardado()).toBe(24 * 60 * 60);
    });
  });

  it('misma clave, mismo usuario, método y ruta: devuelve lo cacheado', async () => {
    await run({ route: '/orders/:id/payment/unpaid' }, 'A');
    const r = await run({ route: '/orders/:id/payment/unpaid' }, 'B');
    expect(r.body).toBe('A');
    expect(r.ejecutado).toBe(0);
  });

  it('la misma clave en otra ruta (cash-received vs unpaid) NO devuelve la respuesta de la otra', async () => {
    await run({ route: '/orders/:id/payment/cash-received' }, 'cobrado');
    const r = await run({ route: '/orders/:id/payment/unpaid' }, 'impago');
    expect(r.body).toBe('impago');
    expect(r.ejecutado).toBe(1);
  });

  it('la misma clave de otro usuario ejecuta de nuevo', async () => {
    await run({ route: '/orders/:id/payment/unpaid' }, 'A');
    const r = await run(
      { route: '/orders/:id/payment/unpaid', userId: 'u2' },
      'B',
    );
    expect(r.body).toBe('B');
  });

  it('la misma clave sobre otro pedido ejecuta de nuevo', async () => {
    await run({ route: '/orders/:id/payment/unpaid' }, 'A');
    const r = await run(
      { route: '/orders/:id/payment/unpaid', params: { id: 'o2' } },
      'B',
    );
    expect(r.body).toBe('B');
  });

  it('misma clave con otro body: 422 y el handler no se ejecuta', async () => {
    await run({ route: '/x/:id/reload', body: { qty: 5 } }, 'A');
    const handler = jest.fn(() => of('B'));
    const intento = interceptor.intercept(
      ctx({ route: '/x/:id/reload', body: { qty: 6 } }),
      { handle: handler },
    );
    await expect(intento).rejects.toThrow(UnprocessableEntityException);
    await expect(intento).rejects.toThrow(MENSAJE_CLAVE_OTROS_DATOS);
    await expect(intento).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_REUSED' },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('la misma clave con otro archivo (multipart) es 422 y no ejecuta', async () => {
    await run({ route: '/x/:id/foto', archivo: Buffer.from('uno') }, 'A');
    const handler = jest.fn(() => of('B'));
    await expect(
      interceptor.intercept(
        ctx({ route: '/x/:id/foto', archivo: Buffer.from('dos') }),
        { handle: handler },
      ),
    ).rejects.toThrow(UnprocessableEntityException);
    expect(handler).not.toHaveBeenCalled();
    const igual = await run(
      { route: '/x/:id/foto', archivo: Buffer.from('uno') },
      'C',
    );
    expect(igual.body).toBe('A');
  });

  it('la misma clave en otra distribuidora ejecuta de nuevo (alcance por tenant)', async () => {
    await run({ route: '/x/:id/y', distributorId: 'dist-a' }, 'A');
    const r = await run({ route: '/x/:id/y', distributorId: 'dist-b' }, 'B');
    expect(r.body).toBe('B');
    expect(r.ejecutado).toBe(1);
  });

  it('la misma clave en la misma distribuidora devuelve lo cacheado', async () => {
    await run({ route: '/x/:id/y', distributorId: 'dist-a' }, 'A');
    const r = await run({ route: '/x/:id/y', distributorId: 'dist-a' }, 'B');
    expect(r.body).toBe('A');
    expect(r.ejecutado).toBe(0);
  });

  it('cache corrupto: se borra y la operación se ejecuta', async () => {
    await run({ route: '/x/:id/y' }, 'A');
    const [clave] = [...store.keys()];
    store.set(clave, '{no es json');
    const r = await run({ route: '/x/:id/y' }, 'B');
    expect(r.body).toBe('B');
    expect(r.ejecutado).toBe(1);
    expect(redisMock.del).toHaveBeenCalledWith(clave);
    // y la respuesta nueva quedó guardada
    const otra = await run({ route: '/x/:id/y' }, 'C');
    expect(otra.body).toBe('B');
    expect(otra.ejecutado).toBe(0);
  });

  it('con la misma clave en curso responde 409 y no ejecuta', async () => {
    lockOcupado = true;
    const handler = jest.fn(() => of('A'));
    await expect(
      interceptor.intercept(ctx({ route: '/x/:id/y' }), { handle: handler }),
    ).rejects.toMatchObject({
      response: {
        code: 'IDEMPOTENCY_IN_PROGRESS',
        message: expect.stringContaining('Idempotency-Key') as string,
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('el lock se pide con renovación automática (withLock)', async () => {
    await run({ route: '/x/:id/y' }, 'A');
    expect(redisMock.withLock).toHaveBeenCalledTimes(1);
  });

  it('mismo body con las claves en otro orden: mismo hash, devuelve lo cacheado', async () => {
    await run(
      {
        route: '/x/:id/reload',
        body: { a: 1, b: { c: 2, d: [1, { f: 1, e: 2 }] } },
      },
      'A',
    );
    const r = await run(
      {
        route: '/x/:id/reload',
        body: { b: { d: [1, { e: 2, f: 1 }], c: 2 }, a: 1 },
      },
      'B',
    );
    expect(r.body).toBe('A');
    expect(r.ejecutado).toBe(0);
  });

  describe('rutas multipart (corren después de multer)', () => {
    beforeEach(() => {
      multipart = true;
    });

    it('el interceptor global las saltea: no toca Redis ni compara nada', async () => {
      const handler = jest.fn(() => of('X'));
      const out = await interceptor.intercept(ctx({ route: '/x/:id/foto' }), {
        handle: handler,
      });
      expect(await lastValueFrom(out)).toBe('X');
      expect(redisMock.withLock).not.toHaveBeenCalled();
    });

    it('la versión de método sí aplica la idempotencia, con el archivo en la huella', async () => {
      const despues = new IdempotencyDespuesDeMulterInterceptor(
        redisParaMultipart as never,
        reflector,
      );
      const correr = async (archivo: Buffer, respuesta: string) => {
        const handler = jest.fn(() => of(respuesta));
        const out = await despues.intercept(
          ctx({ route: '/x/:id/foto', archivo }),
          { handle: handler },
        );
        return {
          body: await lastValueFrom(out),
          ejecutado: handler.mock.calls.length,
        };
      };
      await correr(Buffer.from('uno'), 'A');
      const igual = await correr(Buffer.from('uno'), 'B');
      expect(igual).toEqual({ body: 'A', ejecutado: 0 });
      await expect(correr(Buffer.from('dos'), 'C')).rejects.toThrow(
        UnprocessableEntityException,
      );
    });
  });

  it('hashDeBody distingue el orden de un arreglo y trata sin body como {}', () => {
    expect(hashDeBody({ l: [1, 2] })).not.toBe(hashDeBody({ l: [2, 1] }));
    expect(hashDeBody(undefined)).toBe(hashDeBody({}));
  });
});
