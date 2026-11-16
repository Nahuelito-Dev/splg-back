import type { DataSource } from 'typeorm';
import { MODULOS } from './catalogo-de-modulos';
import { ModulosDeLaEmpresaRepository } from './modulos-de-la-empresa.repository';

describe('ModulosDeLaEmpresaRepository', () => {
  let query: jest.Mock;
  let repo: ModulosDeLaEmpresaRepository;

  beforeEach(() => {
    query = jest.fn();
    repo = new ModulosDeLaEmpresaRepository({
      query,
      manager: { query },
    } as unknown as DataSource);
  });

  it('la foto del plan: su código y sus módulos (sólo textos); sin suscripción, null', async () => {
    query.mockResolvedValueOnce([
      { plan_code: 'basic', modules: ['express', 3, 'mercadopago'] },
    ]);
    expect(await repo.fotoDelPlan('A')).toEqual({
      planCode: 'basic',
      modules: ['express', 'mercadopago'],
    });
    expect(query).toHaveBeenLastCalledWith(expect.any(String), ['A']);
    query.mockResolvedValueOnce([{ plan_code: 'full', modules: null }]);
    expect(await repo.fotoDelPlan('A')).toEqual({
      planCode: 'full',
      modules: [],
    });
    query.mockResolvedValueOnce([]);
    expect(await repo.fotoDelPlan('A')).toBeNull();
  });

  it('las excepciones de la empresa, con la fecha como Date', async () => {
    query.mockResolvedValueOnce([
      {
        module_key: 'express',
        enabled: false,
        reason: 'Pedido de la empresa',
        expires_at: '2026-12-01T00:00:00.000Z',
      },
      {
        module_key: 'repurchase',
        enabled: null,
        reason: 'Vuelve a lo del plan',
        expires_at: null,
      },
    ]);
    expect(await repo.excepciones('A')).toEqual([
      {
        moduleKey: 'express',
        enabled: false,
        reason: 'Pedido de la empresa',
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
      },
      {
        moduleKey: 'repurchase',
        enabled: null,
        reason: 'Vuelve a lo del plan',
        expiresAt: null,
      },
    ]);
  });

  it('guarda la excepción en una sola sentencia que reemplaza por la clave', async () => {
    query.mockResolvedValueOnce([]);
    const vence = new Date('2026-12-01T00:00:00Z');
    await repo.guardarExcepcion({
      distributorId: 'A',
      moduleKey: 'express',
      enabled: true,
      reason: 'Prueba de quince días',
      expiresAt: vence,
      actorUserId: 'super-1',
    });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO "distributor_module"/);
    expect(sql).toMatch(
      /ON CONFLICT \("distributor_id", "module_key"\) DO UPDATE/,
    );
    expect(sql).not.toMatch(/DELETE/);
    expect(params).toEqual([
      'A',
      'express',
      true,
      'Prueba de quince días',
      vence,
      'super-1',
    ]);
  });

  it('quitar el asistente: la excepción y el interruptor apagado en UNA transacción (con quién lo hizo)', async () => {
    const enLaTransaccion = jest.fn().mockResolvedValue([]);
    const transaction = jest.fn(
      (fn: (m: { query: jest.Mock }) => Promise<unknown>) =>
        fn({ query: enLaTransaccion }),
    );
    const conTx = new ModulosDeLaEmpresaRepository({
      query,
      transaction,
      manager: { query },
    } as unknown as DataSource);
    await conTx.guardarExcepcion({
      distributorId: 'A',
      moduleKey: 'assistant',
      enabled: false,
      reason: 'Dejó de pagar el asistente',
      expiresAt: null,
      actorUserId: 'super-1',
      apagarAsistente: true,
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    const [[insert], [update, params]] = enLaTransaccion.mock.calls as Array<
      [string, unknown[]]
    >;
    expect(insert).toMatch(/INSERT INTO "distributor_module"/);
    expect(update).toMatch(/UPDATE "chat_company_settings"/);
    expect(update).toMatch(/"assistant_ai_enabled" = false/);
    expect(params).toEqual(['A', 'super-1']);
  });

  it('M7 todavía no tiene código: nada pendiente y no consulta', async () => {
    expect(await repo.pendientes('A', 'whatsapp')).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('M8 no deja nada en curso al apagarse: nada pendiente y no consulta', async () => {
    expect(await repo.pendientes('A', 'assistant')).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it.each(MODULOS.filter((m) => m !== 'whatsapp' && m !== 'assistant'))(
    'lo pendiente de %s se cuenta filtrando por la empresa',
    async (modulo) => {
      query.mockResolvedValueOnce([{ n: 3 }]);
      expect(await repo.pendientes('A', modulo)).toBe(3);
      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/"distributor_id" = \$1/);
      expect(params).toEqual(['A']);
    },
  );

  it('sin filas cuenta cero', async () => {
    query.mockReset();
    query.mockResolvedValueOnce([]);
    expect(await repo.pendientes('A', 'express')).toBe(0);
  });
});
