import { PATH_METADATA, VERSION_METADATA } from '@nestjs/common/constants';
import { ReportsController } from './reports.controller';
import { ReportsV2Controller } from './reports-v2.controller';
import { ReportsService } from './reports.service';

describe('informes en la API v2', () => {
  it('vive en `/reports` versión 2 y la v1 sigue sin versión', () => {
    expect(Reflect.getMetadata(VERSION_METADATA, ReportsV2Controller)).toBe(
      '2',
    );
    expect(Reflect.getMetadata(PATH_METADATA, ReportsV2Controller)).toBe(
      'reports',
    );
    expect(
      Reflect.getMetadata(VERSION_METADATA, ReportsController),
    ).toBeUndefined();
  });

  it('el resumen pide el período y el inmediato anterior de la misma cantidad de días', async () => {
    const getSalesSummary = jest
      .fn()
      .mockResolvedValueOnce({
        totalSales: 200,
        totalOrders: 4,
        averageTicket: 50,
      })
      .mockResolvedValueOnce({
        totalSales: 100,
        totalOrders: 2,
        averageTicket: 50,
      });
    const controller = new ReportsV2Controller({
      getSalesSummary,
    } as unknown as ReportsService);
    const r = await controller.resumenDeVentas(
      { from: '2026-10-08', to: '2026-10-14' },
      'd1',
    );
    expect(r.currentRange).toEqual({ from: '2026-10-08', to: '2026-10-14' });
    expect(r.previousRange).toEqual({ from: '2026-10-01', to: '2026-10-07' });
    expect(r.current.totalSales).toBe(200);
    expect(r.previous?.totalSales).toBe(100);
    expect(getSalesSummary).toHaveBeenNthCalledWith(
      2,
      new Date('2026-10-01T03:00:00.000Z'),
      new Date('2026-10-08T03:00:00.000Z'),
      'd1',
    );
  });

  it('con compare=false no calcula el período anterior', async () => {
    const getSalesSummary = jest.fn().mockResolvedValue({
      totalSales: 1,
      totalOrders: 1,
      averageTicket: 1,
    });
    const controller = new ReportsV2Controller({
      getSalesSummary,
    } as unknown as ReportsService);
    const r = await controller.resumenDeVentas({
      from: '2026-10-08',
      to: '2026-10-14',
      compare: false,
    });
    expect(r.previous).toBeNull();
    expect(r.previousRange).toBeNull();
    expect(getSalesSummary).toHaveBeenCalledTimes(1);
  });

  describe('los informes con totales delegan en el servicio con el rango en hora argentina', () => {
    const rows = { rows: [], totals: { totalOrders: 0, totalSales: 0 } };
    const servicio = {
      getSalesByDriverConTotales: jest.fn().mockResolvedValue(rows),
      getSalesByPaymentMethodConTotales: jest.fn().mockResolvedValue(rows),
      getSalesByProductConTotales: jest.fn().mockResolvedValue(rows),
      getSalesSummary: jest.fn().mockResolvedValue({
        totalSales: 0,
        totalOrders: 0,
        averageTicket: 0,
      }),
      getUnpaidTotal: jest
        .fn()
        .mockResolvedValue({ totalOrders: 4, totalAmount: 344000 }),
      getDriverDailyTotals: jest.fn().mockResolvedValue([]),
    };
    const controller = new ReportsV2Controller(
      servicio as unknown as ReportsService,
    );
    const rango = { from: '2026-10-01', to: '2026-10-02' };
    const inicio = new Date('2026-10-01T03:00:00.000Z');
    const fin = new Date('2026-10-03T03:00:00.000Z');

    it('por chofer', async () => {
      expect(await controller.ventasPorChofer(rango, 'd1')).toBe(rows);
      expect(servicio.getSalesByDriverConTotales).toHaveBeenCalledWith(
        inicio,
        fin,
        'd1',
      );
    });

    it('por medio de pago', async () => {
      expect(await controller.ventasPorMedioDePago(rango, 'd1')).toBe(rows);
      expect(servicio.getSalesByPaymentMethodConTotales).toHaveBeenCalledWith(
        inicio,
        fin,
        'd1',
      );
    });

    it('por producto', async () => {
      expect(await controller.ventasPorProducto(rango, 'd1')).toBe(rows);
      expect(servicio.getSalesByProductConTotales).toHaveBeenCalledWith(
        inicio,
        fin,
        'd1',
      );
    });

    it('los impagos de la distribuidora', async () => {
      expect(await controller.unpaidTotal('d1')).toEqual({
        totalOrders: 4,
        totalAmount: 344000,
      });
      expect(servicio.getUnpaidTotal).toHaveBeenCalledWith('d1');
    });

    it('el día a día del chofer sale del usuario del token y su distribuidora', async () => {
      await controller.totalesDelChofer(rango, 'u1', 'd1');
      expect(servicio.getDriverDailyTotals).toHaveBeenCalledWith(
        'u1',
        inicio,
        fin,
        'd1',
      );
    });

    it('sin distribuidora (super admin) y sin fechas pide todo el día de hoy', async () => {
      await controller.ventasPorChofer({});
      await controller.ventasPorMedioDePago({});
      await controller.ventasPorProducto({});
      await controller.unpaidTotal();
      await controller.resumenDeVentas({});
      for (const f of [
        servicio.getSalesByDriverConTotales,
        servicio.getSalesByPaymentMethodConTotales,
        servicio.getSalesByProductConTotales,
      ]) {
        expect(f).toHaveBeenLastCalledWith(
          expect.any(Date),
          expect.any(Date),
          undefined,
        );
      }
      expect(servicio.getUnpaidTotal).toHaveBeenLastCalledWith(undefined);
    });

    it('un rango invertido es un 400', () => {
      expect(() =>
        controller.ventasPorChofer({ from: '2026-10-05', to: '2026-10-01' }),
      ).toThrow('from no puede ser posterior a to');
    });
  });
});
