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
  const soltados: string[] = [];
  const redis = {
    acquireLock: jest.fn((clave: string) =>
      Promise.resolve(
        libres(clave)
          ? (tomados.push(clave),
            {
              release: jest.fn(() => {
                soltados.push(clave);
                return clave.endsWith('b')
                  ? Promise.reject(new Error('redis caído'))
                  : Promise.resolve();
              }),
            })
          : null,
      ),
    ),
  };
  const manager = { find: jest.fn().mockResolvedValue(filas) };
  const ds = {
    transaction: jest.fn((fn: (m: EntityManager) => unknown) =>
      fn(manager as unknown as EntityManager),
    ),
  };
  const locks = new RouteSheetLocks(
    ds as unknown as DataSource,
    redis as unknown as RedisService,
  );
  return { locks, manager, tomados, soltados, redis };
}

describe('RouteSheetLocks.conHojas', () => {
  afterEach(() => jest.restoreAllMocks());

  it('toma los cerrojos en orden de id, bloquea las filas de la distribuidora y devuelve las hojas en el orden pedido', async () => {
    const a = hoja({ batchId: 'a', version: 1 });
    const b = hoja({ batchId: 'b', version: 2 });
    const { locks, manager, tomados, soltados } = armar([a, b]);
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
    // Se sueltan al revés; un release que falla no rompe la operación.
    expect(soltados).toEqual(['route-batch:b', 'route-batch:a']);
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
    const { locks, soltados } = armar([hoja({ batchId: 'a', version: 4 })]);
    const fn = jest.fn();
    await expect(
      locks.conHojas(DIST, [{ id: 'a', version: 3 }], fn),
    ).rejects.toMatchObject({
      response: { code: 'ROUTE_SHEET_VERSION_CONFLICT' },
    });
    expect(fn).not.toHaveBeenCalled();
    expect(soltados).toEqual(['route-batch:a']);
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
    let reloj = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => (reloj += 2_000));
    const { locks, soltados, redis } = armar(
      [hoja({ batchId: 'a' }), hoja({ batchId: 'c' })],
      (clave) => clave !== 'route-batch:c',
    );
    await expect(
      locks.conHojas(DIST, [{ id: 'a' }, { id: 'c' }], jest.fn()),
    ).rejects.toMatchObject({ response: { code: 'ROUTE_SHEET_BUSY' } });
    expect(redis.acquireLock.mock.calls.length).toBeGreaterThan(2);
    expect(soltados).toEqual(['route-batch:a']);
  });
});
