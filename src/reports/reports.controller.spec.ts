import { BadRequestException } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { Granularidad } from './dto/report-range-query.dto';

/**
 * H-57: `granularity=week` se aceptaba (el DTO la valida) pero el controlador
 * la colapsaba a `'day'` antes de pasarla al servicio. El arreglo vive en
 * `reports.service.ts` (que agrupa por `date_trunc`) pero el punto que de
 * verdad decide qué granularidad llega ahí es este controlador
 * (`aGranularidadSql`): un test que sólo mire el servicio no detecta si acá
 * se reintroduce el colapso.
 */
describe('ReportsController — sales-evolution no colapsa week a day (H-57)', () => {
  let controller: ReportsController;
  let service: { getSalesEvolution: jest.Mock };

  beforeEach(() => {
    service = { getSalesEvolution: jest.fn().mockResolvedValue([]) };
    controller = new ReportsController(service as unknown as ReportsService);
  });

  it('granularity=week llega al servicio como "week", no como "day"', async () => {
    await controller.getSalesEvolution(
      { granularity: Granularidad.SEMANA },
      'd1',
    );

    expect(service.getSalesEvolution).toHaveBeenCalledWith(
      expect.any(Date),
      expect.any(Date),
      'week',
      'd1',
    );
  });

  it('granularity=month llega como "month"', async () => {
    await controller.getSalesEvolution({ granularity: Granularidad.MES }, 'd1');

    expect(service.getSalesEvolution).toHaveBeenCalledWith(
      expect.any(Date),
      expect.any(Date),
      'month',
      'd1',
    );
  });

  it('sin granularity, el default es "day"', async () => {
    await controller.getSalesEvolution({}, 'd1');

    expect(service.getSalesEvolution).toHaveBeenCalledWith(
      expect.any(Date),
      expect.any(Date),
      'day',
      'd1',
    );
  });
});

/**
 * Los días son en hora argentina y `to` es inclusivo: el servicio recibe
 * `[inicio de from, inicio del día siguiente a to)`.
 */
describe('ReportsController — días en hora argentina, to inclusivo', () => {
  let controller: ReportsController;
  let service: { getSalesByPaymentMethod: jest.Mock };

  beforeEach(() => {
    service = { getSalesByPaymentMethod: jest.fn().mockResolvedValue([]) };
    controller = new ReportsController(service as unknown as ReportsService);
  });

  it('from = to = un día cubre ese día completo', async () => {
    await controller.getSalesByPayment(
      { from: '2026-07-07', to: '2026-07-07' },
      'd1',
    );

    const [desde, hasta] = service.getSalesByPaymentMethod.mock.calls[0] as [
      Date,
      Date,
    ];
    expect(desde.toISOString()).toBe('2026-07-07T03:00:00.000Z');
    expect(hasta.toISOString()).toBe('2026-07-08T03:00:00.000Z');
  });

  it('sin to usa el mismo día de from', async () => {
    await controller.getSalesByPayment({ from: '2026-07-07' }, 'd1');

    const [desde, hasta] = service.getSalesByPaymentMethod.mock.calls[0] as [
      Date,
      Date,
    ];
    expect(hasta.getTime() - desde.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('con sólo to, el rango es ese día (no hoy)', async () => {
    await controller.getSalesByPayment({ to: '2026-07-07' }, 'd1');
    const [desde, hasta] = service.getSalesByPaymentMethod.mock.calls[0] as [
      Date,
      Date,
    ];
    expect(desde.toISOString()).toBe('2026-07-07T03:00:00.000Z');
    expect(hasta.toISOString()).toBe('2026-07-08T03:00:00.000Z');
  });

  it('from posterior a to responde 400', async () => {
    await expect(
      controller.getSalesByPayment(
        { from: '2026-07-08', to: '2026-07-07' },
        'd1',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(service.getSalesByPaymentMethod).not.toHaveBeenCalled();
  });

  it('sin from ni to es hoy en hora argentina, aunque el proceso corra en UTC', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-08T01:00:00Z'));
    try {
      await controller.getSalesByPayment({}, 'd1');
    } finally {
      jest.useRealTimers();
    }

    const [desde, hasta] = service.getSalesByPaymentMethod.mock.calls[0] as [
      Date,
      Date,
    ];
    expect(desde.toISOString()).toBe('2026-07-07T03:00:00.000Z');
    expect(hasta.toISOString()).toBe('2026-07-08T03:00:00.000Z');
  });
});
