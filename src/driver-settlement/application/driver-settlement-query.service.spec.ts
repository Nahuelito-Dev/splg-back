import type { DataSource } from 'typeorm';
import { DriverSettlementStatus } from '../domain/driver-settlement.enums';
import {
  RendicionEnOtroEstadoError,
  RendicionNoEncontradaError,
} from '../domain/errors/driver-settlement.errors';
import { DriverSettlementQueryService } from './driver-settlement-query.service';
import { dec } from '../../common/utils/dinero';
import type { ProcessConfigService } from '../../distributor/process-config.service';

describe('DriverSettlementQueryService.vistaPrevia', () => {
  const abierta = (extra: Record<string, unknown> = {}) => ({
    settlementId: 's1',
    distributorId: 'd1',
    deliveryId: 'c1',
    businessDate: '2026-11-01',
    status: DriverSettlementStatus.OPEN,
    ...extra,
  });

  /** `userDelChofer`: el `user_id` de la fila de `delivery` (la lee tal cual está, con o sin baja lógica). */
  const armar = (
    fila: unknown,
    esperado: string,
    userDelChofer = 'u-chofer',
  ) => {
    const findOne = jest.fn().mockResolvedValue(fila);
    const query = jest.fn().mockResolvedValue([{ user_id: userDelChofer }]);
    const servicio = new DriverSettlementQueryService(
      {
        manager: { findOne, query },
      } as unknown as DataSource,
      {} as unknown as ProcessConfigService,
    );
    const vivo = jest.spyOn(servicio, 'esperadoEnVivo').mockResolvedValue({
      pedidos: [],
      cashFromOrders: dec(esperado),
      cashFromCollections: dec(0),
      expected: dec(esperado),
    });
    return { servicio, findOne, vivo };
  };

  it('devuelve lo esperado en vivo y la diferencia declarado + gastos − esperado', async () => {
    const { servicio, findOne } = armar(abierta(), '40000.50');
    const r = await servicio.vistaPrevia(
      's1',
      { declaredCash: 36000, expenses: [{ amount: 3500 }, { amount: 0.25 }] },
      'd1',
    );
    expect(r).toEqual({
      expectedCash: 40000.5,
      declaredCash: 36000,
      driverExpenses: 3500.25,
      difference: -500.25,
    });
    expect(findOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        where: { settlementId: 's1', distributorId: 'd1' },
      }),
    );
  });

  it('sin gastos, la diferencia es declarado − esperado', async () => {
    const { servicio } = armar(abierta(), '1000');
    const r = await servicio.vistaPrevia('s1', { declaredCash: 1100 }, 'd1');
    expect(r).toMatchObject({ driverExpenses: 0, difference: 100 });
  });

  it('el chofer no ve la rendición de otro', async () => {
    const { servicio } = armar(abierta(), '1000');
    await expect(
      servicio.vistaPrevia('s1', { declaredCash: 0 }, 'd1', 'u-otro'),
    ).rejects.toBeInstanceOf(RendicionNoEncontradaError);
  });

  it('el chofer dueño la previsualiza, igual que la presenta, aunque su fila de delivery tenga baja lógica', async () => {
    const { servicio } = armar(abierta(), '1000');
    const r = await servicio.vistaPrevia(
      's1',
      { declaredCash: 1000 },
      'd1',
      'u-chofer',
    );
    expect(r.difference).toBe(0);
  });

  it('una rendición de otra distribuidora (o inexistente) es 404', async () => {
    const { servicio } = armar(null, '0');
    await expect(
      servicio.vistaPrevia('s1', { declaredCash: 0 }, 'd2'),
    ).rejects.toBeInstanceOf(RendicionNoEncontradaError);
  });

  it('sólo se previsualiza una abierta', async () => {
    const { servicio, vivo } = armar(
      abierta({ status: DriverSettlementStatus.SUBMITTED }),
      '0',
    );
    await expect(
      servicio.vistaPrevia('s1', { declaredCash: 0 }, 'd1'),
    ).rejects.toBeInstanceOf(RendicionEnOtroEstadoError);
    expect(vivo).not.toHaveBeenCalled();
  });
});

describe('DriverSettlementQueryService.efectivoSinRendir (C4)', () => {
  const armar = (filas: unknown[], minHours = 24, enabled = 1) => {
    const query = jest.fn().mockResolvedValue(filas);
    const obtener = jest.fn().mockResolvedValue({ minHours, enabled });
    const servicio = new DriverSettlementQueryService(
      { manager: { query } } as unknown as DataSource,
      { obtener } as unknown as ProcessConfigService,
    );
    return { servicio, query, obtener };
  };
  const hace = (horas: number) => new Date(Date.now() - horas * 3_600_000);

  it('suma por chofer, marca los que pasaron el umbral y totaliza', async () => {
    const { servicio, obtener } = armar(
      [
        {
          delivery_id: 'a',
          driver_name: 'Ana',
          total: '10000',
          sena: '0',
          delivered_at: hace(30),
        },
        {
          delivery_id: 'b',
          driver_name: 'Beto',
          total: '5000',
          sena: '1000',
          delivered_at: hace(3),
        },
      ],
      24,
    );

    const r = await servicio.efectivoSinRendir('d1');

    expect(obtener).toHaveBeenCalledWith('d1', 'cash_alerts');
    expect(r.minHours).toBe(24);
    expect(r.totalAmount).toBe(14000);
    expect(r.totalOrders).toBe(2);
    expect(r.items.map((i) => [i.deliveryId, i.overdue])).toEqual([
      ['a', true],
      ['b', false],
    ]);
  });

  it('sin efectivo pendiente devuelve la lista vacía y el total en cero', async () => {
    const { servicio } = armar([]);
    expect(await servicio.efectivoSinRendir('d1')).toEqual({
      items: [],
      totalAmount: 0,
      totalOrders: 0,
      minHours: 24,
      enabled: true,
    });
  });

  it('con el aviso apagado lo dice (el panel no promete el aviso del cierre)', async () => {
    const { servicio } = armar([], 24, 0);
    expect((await servicio.efectivoSinRendir('d1')).enabled).toBe(false);
  });
});
