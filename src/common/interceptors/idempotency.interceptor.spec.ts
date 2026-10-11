import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { IdempotencyInterceptor } from './idempotency.interceptor';

const KEY = '7a1b2c3d-1111-4222-8333-444455556666';

interface Pedido {
  userId?: string;
  method?: string;
  route: string;
  params?: Record<string, string>;
}

describe('IdempotencyInterceptor', () => {
  let store: Map<string, string>;
  let interceptor: IdempotencyInterceptor;

  beforeEach(() => {
    store = new Map();
    const redis = {
      get: jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
      setex: jest.fn((k: string, _t: number, v: string) => {
        store.set(k, v);
        return Promise.resolve();
      }),
      acquireLock: jest.fn().mockResolvedValue({
        release: jest.fn().mockResolvedValue(undefined),
      }),
    };
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(true),
    } as unknown as Reflector;
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
          user: { user_id: p.userId ?? 'u1' },
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
});
