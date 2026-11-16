import { DataSource, Repository } from 'typeorm';
import { Car } from '../../car/entities/car.entity';
import { ESQUEMAS, valoresPorOmision } from '../../distributor/process-config';
import { ConfigurableProcess } from '../../distributor/entities/module-config.entity';
import { MaintenancePlanningCase } from '../entities/maintenance-planning-case.entity';
import { MaintenanceWindowProposal } from '../entities/maintenance-window-proposal.entity';
import { MaintenanceTask } from '../entities/maintenance-task.entity';
import { PlannerContextService } from './planner-context.service';

const AHORA = new Date('2026-10-30T15:00:00Z');
const PARAMS = valoresPorOmision(ESQUEMAS[ConfigurableProcess.FLEET_PLANNER]);
const auto = (carId: string) => ({ carId }) as Car;

describe('PlannerContextService', () => {
  let query: jest.Mock;
  let tareasProgramadas: Array<Partial<MaintenanceTask>>;
  let casosAcordados: Array<Partial<MaintenancePlanningCase>>;
  let propuestasPendientes: unknown[];
  let servicio: PlannerContextService;

  beforeEach(() => {
    query = jest.fn().mockResolvedValue([]);
    tareasProgramadas = [];
    casosAcordados = [];
    propuestasPendientes = [];
    const qb = {
      select: () => qb,
      where: () => qb,
      andWhere: () => qb,
      getMany: () => Promise.resolve(tareasProgramadas),
    };
    servicio = new PlannerContextService(
      { query } as unknown as DataSource,
      {
        createQueryBuilder: () => qb,
      } as unknown as Repository<MaintenanceTask>,
      {
        find: () => Promise.resolve(casosAcordados),
      } as unknown as Repository<MaintenancePlanningCase>,
      {
        find: () => Promise.resolve(propuestasPendientes),
      } as unknown as Repository<MaintenanceWindowProposal>,
    );
  });

  /** Responde cada consulta según lo que pide: zonas, demanda histórica o pedidos agendados. */
  const responder = (r: {
    zonas?: unknown[];
    demanda?: unknown[];
    agendados?: unknown[];
  }) =>
    query.mockImplementation((sql: string) => {
      if (sql.includes('GROUP BY 1, 2')) return Promise.resolve(r.zonas ?? []);
      if (sql.includes('scheduled_date'))
        return Promise.resolve(r.agendados ?? []);
      return Promise.resolve(r.demanda ?? []);
    });

  it('la zona de un vehículo es aquella donde más entregó', async () => {
    responder({
      zonas: [
        { car_id: 'a', zone_id: 'z1', n: 3 },
        { car_id: 'a', zone_id: 'z2', n: 9 },
        { car_id: 'b', zone_id: 'z1', n: 4 },
      ],
    });
    const ctx = await servicio.cargar(
      'd1',
      [auto('a'), auto('b'), auto('c')],
      PARAMS,
      AHORA,
    );

    expect(ctx.zonaDelVehiculo.get('a')).toBe('z2');
    expect(ctx.zonaDelVehiculo.get('b')).toBe('z1');
    expect(ctx.zonaDelVehiculo.has('c')).toBe(false);
    expect([...(ctx.vehiculosDeLaZona.get('z1') ?? [])]).toEqual(['b']);
  });

  it('consulta las entregas de la distribuidora en los días de la configuración', async () => {
    await servicio.cargar(
      'd1',
      [auto('a')],
      { ...PARAMS, zoneLookbackDays: 7 },
      AHORA,
    );
    const [sql, valores] = query.mock.calls[0] as [
      string,
      [string, string[], Date],
    ];
    expect(sql).toContain(`"distributor_id" = $1`);
    expect(valores[0]).toBe('d1');
    expect(valores[2].toISOString()).toBe('2026-10-23T15:00:00.000Z');
  });

  it('unidades: descuenta el vehículo y los que ya tienen taller ese día', async () => {
    responder({
      zonas: ['a', 'b', 'c'].map((id) => ({ car_id: id, zone_id: 'z1', n: 5 })),
    });
    tareasProgramadas = [
      { carId: 'b', scheduledAt: new Date('2026-11-03T14:00:00Z') },
    ];
    casosAcordados = [
      { carId: 'c', chosenStart: new Date('2026-11-04T14:00:00Z') },
    ];
    const ctx = await servicio.cargar(
      'd1',
      ['a', 'b', 'c'].map(auto),
      PARAMS,
      AHORA,
    );
    const unidades = ctx.unidadesDe('a');

    expect(unidades('2026-11-02')).toBe(2); // quedan b y c
    expect(unidades('2026-11-03')).toBe(1); // b ya está en el taller
    expect(unidades('2026-11-04')).toBe(1); // c tiene un taller acordado
  });

  it('la propuesta que espera al chofer también reserva el día para su vehículo', async () => {
    responder({
      zonas: ['a', 'b', 'c'].map((id) => ({ car_id: id, zone_id: 'z1', n: 5 })),
    });
    propuestasPendientes = [
      {
        windowStart: new Date('2026-11-05T11:00:00Z'),
        planningCase: { carId: 'b' },
      },
    ];
    const ctx = await servicio.cargar(
      'd1',
      ['a', 'b', 'c'].map(auto),
      PARAMS,
      AHORA,
    );
    expect(ctx.unidadesDe('a')('2026-11-05')).toBe(1); // b tiene una propuesta ese día
    expect(ctx.unidadesDe('a')('2026-11-06')).toBe(2);
  });

  it('un vehículo sin zona no tiene restricción de cobertura', async () => {
    const ctx = await servicio.cargar('d1', [auto('a')], PARAMS, AHORA);
    expect(ctx.unidadesDe('a')('2026-11-02')).toBeNull();
  });

  it('demanda: promedio semanal por día de la semana más los pedidos agendados', async () => {
    responder({
      // lunes (1): 16 pedidos en 8 semanas = 2 por lunes
      demanda: [{ dow: 1, n: 16 }],
      agendados: [{ day: '2026-11-02', n: 3 }],
    });
    const ctx = await servicio.cargar('d1', [auto('a')], PARAMS, AHORA);
    const demanda = await ctx.demandaDe(null);

    expect(demanda('2026-11-02')).toBe(5); // lunes con 3 agendados
    expect(demanda('2026-11-09')).toBe(2); // otro lunes
    expect(demanda('2026-11-03')).toBe(0); // martes sin historia
  });

  it('la demanda filtra por la zona del vehículo y se calcula una vez por zona', async () => {
    const ctx = await servicio.cargar('d1', [auto('a')], PARAMS, AHORA);
    query.mockClear();
    await ctx.demandaDe('z1');
    await ctx.demandaDe('z1');
    expect(query).toHaveBeenCalledTimes(2); // histórico + agendados, una sola vez
    const valores = (query.mock.calls[0] as [string, unknown[]])[1];
    expect(valores[valores.length - 1]).toBe('z1');
  });

  it('sin vehículos no consulta las zonas', async () => {
    const ctx = await servicio.cargar('d1', [], PARAMS, AHORA);
    expect(ctx.zonaDelVehiculo.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});
