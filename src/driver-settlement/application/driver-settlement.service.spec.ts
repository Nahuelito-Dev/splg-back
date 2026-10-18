import { DataSource, EntityManager } from 'typeorm';
import { DriverSettlementService } from './driver-settlement.service';

describe('DriverSettlementService.generarDelDia', () => {
  afterEach(() => jest.useRealTimers());

  it('a las 23:00 ART usa el día argentino y su rango como instante', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-18T02:00:00.000Z'));
    const query = jest.fn().mockResolvedValue([]);
    const servicio = new DriverSettlementService(
      { manager: { query } } as unknown as DataSource,
      ...([null, null, null, null, null] as unknown as [
        never,
        never,
        never,
        never,
        never,
      ]),
    );

    await expect(servicio.generarDelDia()).resolves.toBe(0);

    expect(query).toHaveBeenCalledTimes(1);
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([
      new Date('2026-10-18T03:00:00.000Z'),
      '2026-10-17',
    ]);
  });
});

describe('DriverSettlementService.bloquearAbiertaDelChofer', () => {
  const servicio = new DriverSettlementService(
    {} as unknown as DataSource,
    ...([null, null, null, null, null] as unknown as [
      never,
      never,
      never,
      never,
      never,
    ]),
  );

  it('toma la más nueva sin LIMIT (un LIMIT con FOR UPDATE puede devolver vacío tras esperar el lock)', async () => {
    const query = jest
      .fn()
      .mockResolvedValue([
        { settlement_id: 's-nueva' },
        { settlement_id: 's-vieja' },
      ]);
    const id = await servicio.bloquearAbiertaDelChofer(
      { query } as unknown as EntityManager,
      'dist-1',
      'chofer-1',
    );
    expect(id).toBe('s-nueva');
    const [sql] = query.mock.calls[0] as [string];
    expect(sql).not.toMatch(/LIMIT/i);
    expect(sql).toContain('FOR UPDATE');
  });

  it('409 si no tiene rendición abierta', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await expect(
      servicio.bloquearAbiertaDelChofer(
        { query } as unknown as EntityManager,
        'dist-1',
        'chofer-1',
      ),
    ).rejects.toThrow('No tenés una rendición abierta');
  });
});

describe('DriverSettlementService: gastos con categoría', () => {
  const servicio = new DriverSettlementService(
    {} as unknown as DataSource,
    ...([null, null, null, null, null] as unknown as [
      never,
      never,
      never,
      never,
      never,
    ]),
  );
  const validar = (categoria: object | null) =>
    (
      servicio as unknown as {
        validarCategoriasDeGasto(
          m: EntityManager,
          d: string,
          ids: string[],
        ): Promise<void>;
      }
    ).validarCategoriasDeGasto(
      {
        findOne: jest.fn().mockResolvedValue(categoria),
      } as unknown as EntityManager,
      'dist-1',
      ['cat-1'],
    );

  it('una categoría de gasto desactivada se rechaza (400)', async () => {
    await expect(
      validar({ name: 'Peaje', direction: 'expense', isActive: false }),
    ).rejects.toThrow('desactivada');
  });

  it('una activa de gastos pasa', async () => {
    await expect(
      validar({ name: 'Peaje', direction: 'expense', isActive: true }),
    ).resolves.toBeUndefined();
  });
});
