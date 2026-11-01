import type { DataSource } from 'typeorm';
import { DriverSettlementStatus } from '../domain/driver-settlement.enums';
import {
  RendicionEnOtroEstadoError,
  RendicionNoEncontradaError,
} from '../domain/errors/driver-settlement.errors';
import { DriverSettlementQueryService } from './driver-settlement-query.service';
import { dec } from '../../common/utils/dinero';

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
    const servicio = new DriverSettlementQueryService({
      manager: { findOne, query },
    } as unknown as DataSource);
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
