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
