import { Repository } from 'typeorm';
import { ProcessConfigService } from '../../distributor/process-config.service';
import { RoutePlanningHoliday } from '../../order/entities/route-planning-holiday.entity';
import { RoutePlanningCalendarService } from './route-planning-calendar.service';
import { DIST } from './route-sheet.fixtures';

const feriado = (over: Partial<RoutePlanningHoliday> = {}) =>
  Object.assign(new RoutePlanningHoliday(), {
    holidayId: 'f1',
    distributorId: DIST,
    date: '2026-12-08',
    description: 'Inmaculada Concepción',
    createdAt: new Date('2026-11-14T12:00:00Z'),
    ...over,
  });

const codigo = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'sin error';
  } catch (e) {
    return (e as { getResponse: () => { code?: string } }).getResponse().code;
  }
};

function armar(workingDays = 63) {
  const repo = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(feriado()),
    create: jest.fn((x: Partial<RoutePlanningHoliday>) => feriado(x)),
    save: jest.fn((x: RoutePlanningHoliday) => Promise.resolve(x)),
    softDelete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const processConfig = {
    obtener: jest.fn().mockResolvedValue({ workingDays }),
  };
  return {
    repo,
    processConfig,
    svc: new RoutePlanningCalendarService(
      repo as unknown as Repository<RoutePlanningHoliday>,
      processConfig as unknown as ProcessConfigService,
    ),
  };
}

describe('RoutePlanningCalendarService', () => {
  it('calendario: los días de workingDays y los feriados de la distribuidora desde esa fecha', async () => {
    const t = armar(31);
    t.repo.find.mockResolvedValue([feriado({ date: '2026-11-23' })]);
    const cal = await t.svc.calendario(DIST, '2026-11-20');
    expect([...cal.diasHabiles]).toEqual([1, 2, 3, 4, 5]);
    expect([...cal.feriados]).toEqual(['2026-11-23']);
    const where = (t.repo.find.mock.calls as unknown[][])[0][0] as {
      where: { distributorId: string; date: { value: string[] } };
    };
    expect(where.where.distributorId).toBe(DIST);
    expect(where.where.date.value[0]).toBe('2026-11-20');
    expect(t.processConfig.obtener).toHaveBeenCalledWith(
      DIST,
      'route_planning',
    );
  });

  it('listar: de la distribuidora, por fecha, desde hoy por omisión o en el rango pedido', async () => {
    const t = armar();
    await t.svc.listar(DIST, {}, '2026-11-14');
    const sinRango = (t.repo.find.mock.calls as unknown[][])[0][0] as {
      where: { distributorId: string; date: { type: string; value: string } };
      order: unknown;
    };
    expect(sinRango.where.distributorId).toBe(DIST);
    expect(sinRango.where.date).toMatchObject({
      type: 'moreThanOrEqual',
      value: '2026-11-14',
    });
    expect(sinRango.order).toEqual({ date: 'ASC' });
    await t.svc.listar(DIST, { from: '2026-01-01', to: '2026-12-31' });
    const conRango = (t.repo.find.mock.calls as unknown[][])[1][0] as {
      where: { date: { type: string; value: string[] } };
    };
    expect(conRango.where.date).toMatchObject({
      type: 'between',
      value: ['2026-01-01', '2026-12-31'],
    });
  });

  it('crear: guarda el feriado de la distribuidora con la descripción sin espacios de más', async () => {
    const t = armar();
    const f = await t.svc.crear(
      DIST,
      { date: '2026-12-08', description: '  Inmaculada Concepción ' },
      '2026-11-14',
    );
    expect(t.repo.create).toHaveBeenCalledWith({
      distributorId: DIST,
      date: '2026-12-08',
      description: 'Inmaculada Concepción',
    });
    expect(f.date).toBe('2026-12-08');
  });

  it('crear: 409 si el día ya pasó o ya está cargado (único vigente por día); otro error sube', async () => {
    const t = armar();
    expect(
      await codigo(
        t.svc.crear(
          DIST,
          { date: '2026-11-13', description: 'Ayer' },
          '2026-11-14',
        ),
      ),
    ).toBe('ROUTE_HOLIDAY_DATE_PAST');
    expect(t.repo.save).not.toHaveBeenCalled();
    t.repo.save.mockRejectedValueOnce({ code: '23505' });
    expect(
      await codigo(
        t.svc.crear(
          DIST,
          { date: '2026-11-14', description: 'Hoy' },
          '2026-11-14',
        ),
      ),
    ).toBe('ROUTE_HOLIDAY_ALREADY_EXISTS');
    t.repo.save.mockRejectedValueOnce(new Error('base caída'));
    await expect(
      t.svc.crear(DIST, { date: '2026-12-25', description: 'Navidad' }),
    ).rejects.toThrow('base caída');
  });

  it('borrar: baja lógica del de la distribuidora; de otra (o ya dado de baja), 404', async () => {
    const t = armar();
    await t.svc.borrar(DIST, 'f1');
    expect(t.repo.findOne).toHaveBeenCalledWith({
      where: { holidayId: 'f1', distributorId: DIST },
    });
    expect(t.repo.softDelete).toHaveBeenCalledWith({
      holidayId: 'f1',
      distributorId: DIST,
    });
    t.repo.findOne.mockResolvedValue(null);
    expect(await codigo(t.svc.borrar('otra', 'f1'))).toBe(
      'ROUTE_HOLIDAY_NOT_FOUND',
    );
    expect(t.repo.softDelete).toHaveBeenCalledTimes(1);
  });
});
