import type { DataSource } from 'typeorm';
import type { RedisService } from '../../redis/redis.service';
import { MODULOS_POR_PLAN } from '../modules/catalogo-de-modulos';
import { RedisEnMemoria } from '../../process-run/testing/empresas-de-prueba';
import {
  AccesoDeLaEmpresa,
  claveDeAcceso,
  claveDeVersion,
  MOTIVO_NO_DISPONIBLE,
} from './acceso-de-la-empresa.service';

const TOPES = {
  maxDrivers: 10,
  maxAdmins: 3,
  maxOrdersMonth: null,
  documentReadingUsdMonth: 0,
};

describe('AccesoDeLaEmpresa (§6.1)', () => {
  let query: jest.Mock;
  let redis: RedisEnMemoria;
  let acceso: AccesoDeLaEmpresa;
  /** Lo que devuelve la base por empresa. */
  let empresas: Record<
    string,
    {
      status: string;
      deleted: boolean;
      plan_code: string | null;
      plan_snapshot: unknown;
    }
  >;
  let excepciones: Record<
    string,
    Array<{ module_key: string; enabled: boolean }>
  >;

  beforeEach(() => {
    empresas = {
      A: {
        status: 'active',
        deleted: false,
        plan_code: 'basic',
        plan_snapshot: { modules: ['mercadopago', 'express'], limits: TOPES },
      },
      B: {
        status: 'active',
        deleted: false,
        plan_code: 'basic',
        plan_snapshot: { modules: ['mercadopago', 'express'], limits: TOPES },
      },
    };
    excepciones = {};
    query = jest.fn((sql: string, [id]: [string]) =>
      Promise.resolve(
        sql.includes('"distributor_module"')
          ? (excepciones[id] ?? [])
          : empresas[id]
            ? [empresas[id]]
            : [],
      ),
    );
    redis = new RedisEnMemoria();
    acceso = new AccesoDeLaEmpresa(
      { query } as unknown as DataSource,
      redis as unknown as RedisService,
    );
  });

  it('habilitados = los de la foto del plan, con sus topes', async () => {
    const v = await acceso.vigente('A');
    expect(v).toMatchObject({
      distributorId: 'A',
      nivel: 'full',
      aceptaPedidos: true,
      limites: TOPES,
      motivo: null,
      planCode: 'basic',
    });
    expect([...v.modulos].sort()).toEqual(['express', 'mercadopago']);
  });

  it('una excepción vigente manda sobre el plan (habilita o deshabilita); la consulta trae sólo las vigentes', async () => {
    excepciones.A = [
      { module_key: 'document_reading', enabled: true },
      { module_key: 'mercadopago', enabled: false },
      { module_key: 'inventado', enabled: true },
    ];
    const v = await acceso.vigente('A');
    expect([...v.modulos].sort()).toEqual(['document_reading', 'express']);
    const sql = query.mock.calls
      .map(([s]) => s as string)
      .find((s) => s.includes('"distributor_module"'));
    expect(sql).toMatch(/"enabled" IS NOT NULL/);
    expect(sql).toMatch(/"expires_at" IS NULL OR "expires_at" > now\(\)/);
  });

  it('cambiar los módulos de A no cambia los de B', async () => {
    excepciones.A = [{ module_key: 'express', enabled: false }];
    const a = await acceso.vigente('A');
    const b = await acceso.vigente('B');
    expect(a.modulos.has('express')).toBe(false);
    expect(b.modulos.has('express')).toBe(true);
  });

  it.each([
    ['suspendida', { status: 'suspended', deleted: false }],
    ['dada de baja', { status: 'active', deleted: true }],
  ])('una empresa %s queda bloqueada y sin módulos', async (_c, cambio) => {
    Object.assign(empresas.A, cambio);
    const v = await acceso.vigente('A');
    expect(v).toMatchObject({
      nivel: 'blocked',
      aceptaPedidos: false,
      motivo: MOTIVO_NO_DISPONIBLE,
      limites: TOPES,
      planCode: 'basic',
    });
    expect(v.modulos.size).toBe(0);
  });

  it('una empresa inexistente queda bloqueada sin topes', async () => {
    const v = await acceso.vigente('X');
    expect(v).toMatchObject({ nivel: 'blocked', planCode: null });
    expect(v.limites.maxDrivers).toBeNull();
  });

  it('sin suscripción rige el plan completo: la falta de la fila nunca apaga nada', async () => {
    empresas.A.plan_snapshot = null;
    empresas.A.plan_code = null;
    const v = await acceso.vigente('A');
    expect(v.nivel).toBe('full');
    expect([...v.modulos].sort()).toEqual([...MODULOS_POR_PLAN.full].sort());
    // Lo apagado por omisión (M8) tampoco se prende por falta de la fila.
    expect(v.modulos.has('assistant')).toBe(false);
    expect(v.limites.maxDrivers).toBeNull();
  });

  it('de la foto ignora lo que no es un módulo del catálogo', async () => {
    empresas.A.plan_snapshot = {
      modules: ['express', 7, 'otro'],
      limits: TOPES,
    };
    expect([...(await acceso.vigente('A')).modulos]).toEqual(['express']);
  });

  it('guarda en la caché `acceso:<id>:<versión>` por 60 s y la usa sin ir a la base', async () => {
    const setex = jest.spyOn(redis, 'setex');
    await acceso.vigente('A');
    expect(setex).toHaveBeenCalledWith(
      claveDeAcceso('A', '0'),
      60,
      expect.any(String),
    );
    query.mockClear();
    const v = await acceso.vigente('A');
    expect(query).not.toHaveBeenCalled();
    expect(v.modulos).toEqual(new Set(['mercadopago', 'express']));
    expect(await acceso.habilitado('A', 'express')).toBe(true);
    expect(await acceso.habilitado('A', 'repurchase')).toBe(false);
  });

  it('invalidar sube la versión: la próxima lectura va a la base y ve el cambio', async () => {
    await acceso.vigente('A');
    excepciones.A = [{ module_key: 'express', enabled: false }];
    await acceso.invalidar('A');
    expect(await redis.get(claveDeVersion('A'))).toBe('1');
    expect((await acceso.vigente('A')).modulos.has('express')).toBe(false);
    // B no se toca.
    expect(await redis.get(claveDeVersion('B'))).toBeNull();
  });

  it('carrera: una lectura que calculó ANTES del cambio y guarda DESPUÉS no deja el valor viejo', async () => {
    // La request vieja lee la base (sin excepciones todavía) y queda frenada
    // antes de guardar.
    let soltar!: () => void;
    const frenada = new Promise<void>((r) => (soltar = r));
    const normal = query.getMockImplementation()!;
    query.mockImplementation(async (sql: string, params: [string]) => {
      const filas: unknown = await normal(sql, params);
      if (sql.includes('"distributor_module"')) {
        query.mockImplementation(normal);
        await frenada;
      }
      return filas;
    });
    const vieja = acceso.vigente('A');
    await new Promise((r) => setImmediate(r));
    // Mientras tanto la plataforma apaga express y la caché se invalida.
    excepciones.A = [{ module_key: 'express', enabled: false }];
    await acceso.invalidar('A');
    // Recién ahora la request vieja termina y guarda lo que calculó.
    soltar();
    expect((await vieja).modulos.has('express')).toBe(true);
    // La siguiente lectura NO toma ese valor viejo: ve el cambio.
    expect((await acceso.vigente('A')).modulos.has('express')).toBe(false);
  });

  it('si Redis no responde, consulta la base y no falla', async () => {
    jest.spyOn(redis, 'get').mockRejectedValue(new Error('redis caído'));
    jest.spyOn(redis, 'setex').mockRejectedValue(new Error('redis caído'));
    const v = await acceso.vigente('A');
    expect(v.modulos.has('express')).toBe(true);
    expect(query).toHaveBeenCalled();
  });

  it('si Redis responde la versión pero falla al leer o guardar la caché, igual responde de la base', async () => {
    const get = jest.spyOn(redis, 'get');
    get.mockResolvedValueOnce('3').mockRejectedValueOnce(new Error('caído'));
    jest.spyOn(redis, 'setex').mockRejectedValue(new Error('caído'));
    expect((await acceso.vigente('A')).modulos.has('express')).toBe(true);
  });

  it('invalidar no falla sin Redis', async () => {
    jest.spyOn(redis, 'incr').mockRejectedValue(new Error('redis caído'));
    await expect(acceso.invalidar('A')).resolves.toBeUndefined();
  });
});
