import { FindOperator } from 'typeorm';
import { OrderService } from './order.service';

/**
 * `getOrderStats` ("hoy", "semana", "mes") se calcula en hora argentina,
 * sin importar la zona horaria del proceso. Este archivo se corre también con
 * `TZ=UTC` (`npm run test:tz`), que es como corre el back en un VPS.
 */
describe('OrderService.getOrderStats — días en hora argentina', () => {
  let sum: jest.Mock;
  let count: jest.Mock;
  let service: OrderService;

  /** Los dos extremos de `And(MoreThanOrEqual(a), LessThan(b))`. */
  function extremos(donde: unknown): [string, string] {
    const { deliveredAt } = donde as { deliveredAt: FindOperator<Date> };
    const [desde, hasta] = (
      deliveredAt as unknown as { value: FindOperator<Date>[] }
    ).value;
    return [desde.value.toISOString(), hasta.value.toISOString()];
  }

  beforeEach(() => {
    sum = jest.fn().mockResolvedValue(0);
    count = jest.fn().mockResolvedValue(0);
    const deliveries = {
      contarEnLinea: jest.fn().mockResolvedValue(0),
      contarHabilitados: jest.fn().mockResolvedValue(0),
    };
    service = Object.assign(Object.create(OrderService.prototype), {
      orderRepository: { sum, count },
      deliveries,
    }) as OrderService;
  });

  afterEach(() => jest.useRealTimers());

  it('a las 22:00 ART del 7/7 (01:00 UTC del 8/7) "hoy" sigue siendo el 7/7', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-08T01:00:00Z'));
    await service.getOrderStats('d1');

    // sum(): hoy, semana, mes, total
    const hoy = extremos((sum.mock.calls[0] as [string, unknown])[1]);
    expect(hoy).toEqual([
      '2026-07-07T03:00:00.000Z',
      '2026-07-08T03:00:00.000Z',
    ]);
    // 7/7/2026 es martes: la semana ISO arranca el lunes 6/7.
    const semana = extremos((sum.mock.calls[1] as [string, unknown])[1]);
    expect(semana).toEqual([
      '2026-07-06T03:00:00.000Z',
      '2026-07-13T03:00:00.000Z',
    ]);
    const mes = extremos((sum.mock.calls[2] as [string, unknown])[1]);
    expect(mes).toEqual([
      '2026-07-01T03:00:00.000Z',
      '2026-08-01T03:00:00.000Z',
    ]);
  });

  it('un domingo pertenece a la semana ISO que arrancó el lunes anterior', async () => {
    // Domingo 12/7 a las 12:00 ART.
    jest.useFakeTimers().setSystemTime(new Date('2026-07-12T15:00:00Z'));
    await service.getOrderStats('d1');
    const semana = extremos((sum.mock.calls[1] as [string, unknown])[1]);
    expect(semana).toEqual([
      '2026-07-06T03:00:00.000Z',
      '2026-07-13T03:00:00.000Z',
    ]);
  });

  it('un lunes arranca una semana ISO nueva', async () => {
    // Lunes 13/7 a las 00:30 ART.
    jest.useFakeTimers().setSystemTime(new Date('2026-07-13T03:30:00Z'));
    await service.getOrderStats('d1');
    const semana = extremos((sum.mock.calls[1] as [string, unknown])[1]);
    expect(semana).toEqual([
      '2026-07-13T03:00:00.000Z',
      '2026-07-20T03:00:00.000Z',
    ]);
  });

  it('a las 00:30 ART del 1/8 (03:30 UTC) el mes en curso ya es agosto', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-01T03:30:00Z'));
    await service.getOrderStats('d1');
    const mes = extremos((sum.mock.calls[2] as [string, unknown])[1]);
    expect(mes).toEqual([
      '2026-08-01T03:00:00.000Z',
      '2026-09-01T03:00:00.000Z',
    ]);
  });
});
