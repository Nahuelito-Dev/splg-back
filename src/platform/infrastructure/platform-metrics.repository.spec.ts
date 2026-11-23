import type { DataSource } from 'typeorm';
import { PlatformMetricsRepository } from './platform-metrics.repository';

/**
 * El SQL real se prueba en el e2e (`plataforma.e2e-spec.ts`, contra Postgres).
 * Acá: que cada método es UNA sentencia marcada, con los parámetros
 * correctos, y que convierte lo que devuelve Postgres (conteos como texto,
 * numéricos como texto, nulos).
 */
function armar(...respuestas: unknown[]) {
  const query = jest.fn<Promise<unknown>, [string, unknown[]?]>();
  for (const r of respuestas) query.mockResolvedValueOnce(r);
  const repo = new PlatformMetricsRepository({
    query,
  } as unknown as DataSource);
  return { repo, query };
}

type Consulta = jest.Mock<Promise<unknown>, [string, unknown[]?]>;

const marca = (query: Consulta, i = 0) =>
  /\/\* plataforma:([a-z-]+) \*\//.exec(query.mock.calls[i][0])?.[1];
const parametros = (query: Consulta, i = 0): unknown[] =>
  query.mock.calls[i][1] ?? [];

const D1 = new Date('2026-11-01T03:00:00Z');
const D2 = new Date('2026-11-15T03:00:00Z');

describe('PlatformMetricsRepository', () => {
  it('empresas: página y total en dos sentencias, con los filtros y el orden de propias primero', async () => {
    const { repo, query } = armar([{ id: 'a' }], [{ total: '7' }]);
    const r = await repo.empresas('active', true, 10, 20);
    expect(r).toEqual({ filas: [{ id: 'a' }], total: 7 });
    expect([marca(query, 0), marca(query, 1)]).toEqual([
      'empresas',
      'empresas-total',
    ]);
    expect(parametros(query, 0)).toEqual(['active', true, 10, 20]);
    expect(parametros(query, 1)).toEqual(['active', true]);
    expect(query.mock.calls[0][0]).toContain(
      'ORDER BY d."owned_by_platform" DESC, d."name", d."distributor_id"',
    );
  });

  it('empresas: sin fila de conteo, total 0', async () => {
    const { repo } = armar([], []);
    expect((await repo.empresas(null, null, 10, 0)).total).toBe(0);
  });

  it('empresa: la fila o null; nombres; estados como números', async () => {
    const { repo, query } = armar(
      [{ id: 'a' }],
      [],
      [{ id: 'a', name: 'Alfa', logo_key: 'k' }],
      [{ status: 'active', cantidad: '3' }],
    );
    expect(await repo.empresa('a')).toEqual({ id: 'a' });
    expect(await repo.empresa('x')).toBeNull();
    expect(await repo.nombres()).toEqual([
      { id: 'a', name: 'Alfa', logo_key: 'k' },
    ]);
    // El logo sale en la misma consulta que los nombres.
    expect(String(query.mock.calls[2][0])).toContain('d."logo_key"');
    expect(await repo.estados()).toEqual([{ status: 'active', cantidad: 3 }]);
    expect(marca(query, 3)).toBe('estados');
  });

  it('métricas: una sentencia para todas las empresas pedidas, con los criterios de venta', async () => {
    const ahora = new Date('2026-11-14T13:00:00Z');
    const { repo, query } = armar([
      {
        id: 'a',
        pedidos: '4',
        ventas: '2',
        facturacion: '150.50',
        choferes: '1',
        clientes: '9',
        ultima_actividad: '2026-11-10T12:00:00.000Z',
        soporte_activo: true,
        soporte_pendiente: '1',
      },
      {
        id: 'b',
        pedidos: null,
        ventas: null,
        facturacion: 12,
        choferes: null,
        clientes: null,
        ultima_actividad: null,
        soporte_activo: null,
        soporte_pendiente: null,
      },
    ]);
    const r = await repo.metricas(['a', 'b'], D1, D2, ahora);
    expect(query).toHaveBeenCalledTimes(1);
    expect(marca(query)).toBe('metricas');
    expect(parametros(query, 0)).toEqual([
      ['a', 'b'],
      D1,
      D2,
      'delivered',
      'paid',
      ahora,
    ]);
    expect(r).toEqual([
      {
        id: 'a',
        pedidos: 4,
        ventas: 2,
        facturacion: '150.50',
        choferes: 1,
        clientes: 9,
        ultima_actividad: new Date('2026-11-10T12:00:00.000Z'),
        soporte_activo: true,
        soporte_pendiente: 1,
      },
      {
        id: 'b',
        pedidos: 0,
        ventas: 0,
        facturacion: '0',
        choferes: 0,
        clientes: 0,
        ultima_actividad: null,
        soporte_activo: false,
        soporte_pendiente: 0,
      },
    ]);
    // El administrador general no cuenta como actividad de la empresa.
    const sql = query.mock.calls[0][0];
    expect(sql).toContain(`IS DISTINCT FROM 'super_admin'`);
    // Dos búsquedas por empresa: el predicado + el orden calzan con los
    // índices (distributor_id, createdAt/created_at DESC) de la migración E3.
    expect(sql).toContain('LEFT JOIN LATERAL');
    expect(sql).toContain('SELECT MAX(actividad.at)');
    expect(sql).toContain(
      'WHERE o."distributor_id" = e."distributor_id"\n                 ORDER BY o."createdAt" DESC\n                 LIMIT 1',
    );
    expect(sql).toContain(
      'WHERE l."distributor_id" = e."distributor_id"\n                   AND l."actor_user_id" IS NOT NULL\n                   AND l."actor_role" IS DISTINCT FROM \'super_admin\'\n                 ORDER BY l."created_at" DESC\n                 LIMIT 1',
    );
  });

  it('lector y sus parámetros', async () => {
    const { repo, query } = armar(
      [{ id: 'a', lecturas: '3', costo: '0.5' }],
      [{ id: 'a', params: { enabled: 1 } }],
    );
    expect(await repo.lector(null, D1, D2)).toEqual([
      { id: 'a', lecturas: 3, costo: '0.5' },
    ]);
    expect(parametros(query, 0)).toEqual([null, D1, D2]);
    expect(await repo.parametrosDelLector(['a'])).toEqual([
      { id: 'a', params: { enabled: 1 } },
    ]);
    expect(parametros(query, 1)).toEqual([['a'], 'document_reading']);
  });

  it('admins (con el último ingreso) y sesiones recientes', async () => {
    const { repo, query } = armar([{ user_id: 'u' }], [{ id: 's' }]);
    expect(await repo.admins('d')).toEqual([{ user_id: 'u' }]);
    expect(parametros(query, 0)).toEqual(['d', 6]);
    expect(await repo.sesionesRecientes('d', 10)).toEqual([{ id: 's' }]);
    expect(parametros(query, 1)).toEqual(['d', 10]);
  });

  it('actividad: filtros, recursos de plataforma e ingresos; convierte las filas', async () => {
    const fila = {
      id: 'x',
      at: '2026-11-14T12:00:00.000Z',
      kind: 'login',
      actor_user_id: 'u',
      actor_name: 'Soporte',
      actor_photo_key: 'users/u/a.jpg',
      actor_role: 'super_admin',
      method: null,
      resource: 'auth',
      resource_id: null,
      path: null,
      distributor_id: null,
      distributor_name: null,
      result: 'success',
      status_code: 200,
      total: '4',
    };
    const { repo, query } = armar(
      [
        fila,
        {
          ...fila,
          kind: 'request',
          actor_user_id: undefined,
          actor_photo_key: undefined,
        },
      ],
      [{ ...fila, total: '9' }],
    );
    const filtro = {
      desde: D1,
      hasta: D2,
      actorUserId: 'u',
      distributorId: null,
      limit: 20,
      offset: 40,
    };
    const r = await repo.actividad(filtro);
    expect(r[0]).toMatchObject({
      kind: 'login',
      at: new Date('2026-11-14T12:00:00.000Z'),
      actor_photo_key: 'users/u/a.jpg',
      total: 4,
    });
    expect(r[1]).toMatchObject({
      kind: 'request',
      actor_user_id: null,
      actor_photo_key: null,
    });
    // La foto del actor sale del mismo JOIN que su nombre.
    expect(String(query.mock.calls[0][0])).toContain(
      'u."photo_key" AS actor_photo_key',
    );
    expect(parametros(query, 0)).toEqual([
      'super_admin',
      ['distributor', 'platform', 'support-sessions', 'support-access', 'role'],
      6,
      D1,
      D2,
      'u',
      null,
      20,
      40,
    ]);
    expect(await repo.totalDeActividad(filtro)).toBe(9);
    expect(parametros(query, 1).slice(-2)).toEqual([1, 0]);
  });

  it('total de actividad sin filas: 0', async () => {
    const { repo } = armar([]);
    expect(
      await repo.totalDeActividad({
        desde: null,
        hasta: null,
        actorUserId: null,
        distributorId: null,
        limit: 1,
        offset: 0,
      }),
    ).toBe(0);
  });
});
