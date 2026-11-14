import { DataSource, EntityManager } from 'typeorm';
import { RouteBatch } from '../../order/entities/route-batch.entity';
import { RedisService } from '../../redis/redis.service';
import { RouteSheetLocks } from './route-sheet-locks.service';
import { DIST, hoja } from './route-sheet.fixtures';

function armar(
  filas: RouteBatch[],
  libres: (clave: string) => boolean = () => true,
) {
  const tomados: string[] = [];
  const redis = {
    withLock: jest.fn(
      async (clave: string, _ttl: number, fn: () => Promise<unknown>) =>
        Promise.resolve(
          libres(clave)
            ? (tomados.push(clave), { obtenido: true, valor: await fn() })
            : { obtenido: false },
        ),
    ),
  };
  const manager = {
    find: jest.fn().mockResolvedValue(filas),
    query: jest.fn().mockResolvedValue([]),
  };
  const ds = {
    transaction: jest.fn((fn: (m: EntityManager) => unknown) =>
      fn(manager as unknown as EntityManager),
    ),
  };
  const locks = new RouteSheetLocks(
    ds as unknown as DataSource,
    redis as unknown as RedisService,
  );
  return { locks, manager, tomados, redis };
}

describe('RouteSheetLocks.conHojas', () => {
  afterEach(() => jest.restoreAllMocks());

  it('toma los cerrojos en orden de id, bloquea las filas de la distribuidora y devuelve las hojas en el orden pedido', async () => {
    const a = hoja({ batchId: 'a', version: 1 });
    const b = hoja({ batchId: 'b', version: 2 });
    const { locks, manager, tomados, redis } = armar([a, b]);
    const r = await locks.conHojas(
      DIST,
      [
        { id: 'b', version: 2 },
        { id: 'a', version: 1 },
      ],
      (_m, hojas) => Promise.resolve(hojas.map((h) => h.batchId)),
    );
    expect(r).toEqual(['b', 'a']);
    expect(tomados).toEqual(['route-batch:a', 'route-batch:b']);
    expect(redis.withLock).toHaveBeenCalledWith(
      'route-batch:a',
      30_000,
      expect.any(Function),
      3_000,
    );
    const opciones = (manager.find.mock.calls as unknown[][])[0][1] as {
      where: { distributorId: string; kind: string };
      lock: { mode: string };
    };
    expect(opciones.where).toMatchObject({
      distributorId: DIST,
      kind: 'planned',
    });
    expect(opciones.lock.mode).toBe('pessimistic_write');
  });

  it('409 ROUTE_SHEET_VERSION_CONFLICT si la versión que vio quien edita ya cambió', async () => {
    const { locks } = armar([hoja({ batchId: 'a', version: 4 })]);
    const fn = jest.fn();
    await expect(
      locks.conHojas(DIST, [{ id: 'a', version: 3 }], fn),
    ).rejects.toMatchObject({
      response: { code: 'ROUTE_SHEET_VERSION_CONFLICT' },
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('sin versión no la controla (lectura con la fila bloqueada)', async () => {
    const { locks } = armar([hoja({ batchId: 'a', version: 9 })]);
    await expect(
      locks.conHojas(DIST, [{ id: 'a' }], () => Promise.resolve('ok')),
    ).resolves.toBe('ok');
  });

  it('404 ROUTE_SHEET_NOT_FOUND si la hoja no es de la distribuidora (no viene en la consulta)', async () => {
    const { locks } = armar([]);
    await expect(
      locks.conHojas(DIST, [{ id: 'ajena', version: 1 }], jest.fn()),
    ).rejects.toMatchObject({ response: { code: 'ROUTE_SHEET_NOT_FOUND' } });
  });

  it('409 ROUTE_SHEET_BUSY si otra sesión tiene el cerrojo pasada la espera, y suelta los que ya tomó', async () => {
    const { locks, redis } = armar(
      [hoja({ batchId: 'a' }), hoja({ batchId: 'c' })],
      (clave) => clave !== 'route-batch:c',
    );
    await expect(
      locks.conHojas(DIST, [{ id: 'a' }, { id: 'c' }], jest.fn()),
    ).rejects.toMatchObject({ response: { code: 'ROUTE_SHEET_BUSY' } });
    expect(redis.withLock).toHaveBeenCalledTimes(2);
  });

  it('orden hoja → pedidos → paradas: bloquea los pedidos de las paradas activas (FOR KEY SHARE, por id) con la hoja ya bloqueada y antes de la operación', async () => {
    const { locks, manager } = armar([
      hoja({ batchId: 'a' }),
      hoja({ batchId: 'b' }),
    ]);
    const fn = jest.fn().mockResolvedValue('ok');
    await locks.conHojas(DIST, [{ id: 'b' }, { id: 'a' }], fn);
    const [sql, params] = manager.query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([['a', 'b'], DIST]);
    expect(sql).toContain('s."batch_id" = ANY($1::uuid[]) AND s."active"');
    expect(sql).toMatch(/ORDER BY o\."order_id"\s+FOR KEY SHARE OF o/);
    const hoja_ = manager.find.mock.invocationCallOrder[0];
    const pedidos = manager.query.mock.invocationCallOrder[0];
    expect(hoja_).toBeLessThan(pedidos);
    expect(pedidos).toBeLessThan(fn.mock.invocationCallOrder[0]);
  });

  it('con pedidos que entran: todos en orden de id, los nuevos FOR UPDATE y los de las paradas FOR KEY SHARE, cada uno una sola vez', async () => {
    const { locks, manager } = armar([hoja({ batchId: 'a' })]);
    manager.query.mockResolvedValueOnce([{ orderId: 'o3' }, { orderId: 'o1' }]);
    await locks.conHojas(DIST, [{ id: 'a' }], () => Promise.resolve(), {
      pedidosNuevos: ['o2', 'o3'],
    });
    const bloqueos = (manager.query.mock.calls as Array<[string, unknown[]]>)
      .slice(1)
      .map(([sql, params]) => [
        params[0],
        sql.includes('FOR UPDATE OF o') ? 'update' : 'key_share',
      ]);
    expect(bloqueos).toEqual([
      ['o1', 'key_share'],
      ['o2', 'update'],
      ['o3', 'update'],
    ]);
  });

  it('una versión vieja no llega a bloquear los pedidos', async () => {
    const { locks, manager } = armar([hoja({ batchId: 'a', version: 4 })]);
    await expect(
      locks.conHojas(DIST, [{ id: 'a', version: 3 }], jest.fn()),
    ).rejects.toMatchObject({
      response: { code: 'ROUTE_SHEET_VERSION_CONFLICT' },
    });
    expect(manager.query).not.toHaveBeenCalled();
  });
});
