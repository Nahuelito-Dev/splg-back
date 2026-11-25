import { BadRequestException } from '@nestjs/common';
import { PATH_METADATA, VERSION_METADATA } from '@nestjs/common/constants';
import { ReportsService } from './reports.service';
import { ReportsV3Controller } from './reports-v3.controller';

describe('informes en la API v3', () => {
  it('expone la utilización por vehículo en la versión 3', async () => {
    const getVehicleUtilization = jest
      .fn()
      .mockResolvedValue({ rows: [], totals: {} });
    const controller = new ReportsV3Controller({
      getVehicleUtilization,
    } as unknown as ReportsService);

    await expect(
      controller.utilization(
        { from: '2026-10-01', to: '2026-10-02', vehicleId: 'v1' },
        'd1',
      ),
    ).resolves.toEqual({ rows: [], totals: {} });
    expect(Reflect.getMetadata(VERSION_METADATA, ReportsV3Controller)).toBe(
      '3',
    );
    expect(Reflect.getMetadata(PATH_METADATA, ReportsV3Controller)).toBe(
      'reports',
    );
    expect(getVehicleUtilization).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '2026-10-01',
        to: '2026-10-02',
        startDate: new Date('2026-10-01T03:00:00.000Z'),
        endDate: new Date('2026-10-03T03:00:00.000Z'),
      }),
      'd1',
      'v1',
    );
  });

  it('rechaza un rango invertido antes de consultar', () => {
    const getVehicleUtilization = jest.fn();
    const controller = new ReportsV3Controller({
      getVehicleUtilization,
    } as unknown as ReportsService);
    expect(() =>
      controller.utilization({ from: '2026-10-02', to: '2026-10-01' }, 'd1'),
    ).toThrow('from no puede ser posterior a to');
    expect(getVehicleUtilization).not.toHaveBeenCalled();
  });

  it('rechaza rangos mayores al máximo con código estable', async () => {
    const getVehicleUtilization = jest.fn();
    const controller = new ReportsV3Controller({
      getVehicleUtilization,
    } as unknown as ReportsService);
    let error: unknown;
    try {
      await controller.utilization(
        { from: '2020-01-01', to: '2025-01-05' },
        'd1',
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toEqual({
      code: 'DATE_RANGE_TOO_LARGE',
      message: 'El rango no puede superar 1830 días',
    });
    expect(getVehicleUtilization).not.toHaveBeenCalled();
  });
});
