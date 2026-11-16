import { MaintenancePlannerController } from './maintenance-planner.controller';
import { DriverMaintenanceProposalsController } from './driver-maintenance-proposals.controller';
import { MaintenancePlannerService } from './maintenance-planner.service';
import { PlanningCaseStatus } from '../entities/maintenance-planning-case.entity';

describe('controladores del planificador', () => {
  let planner: Record<string, jest.Mock>;
  let admin: MaintenancePlannerController;
  let driver: DriverMaintenanceProposalsController;

  const caso = {
    caseId: 'c1',
    status: PlanningCaseStatus.CONFIRMED,
    task: { plan: { name: 'VTV', criticality: 'blocking' } },
    car: { carPatent: 'AB123CD' },
    delivery: null,
    proposals: [],
    evaluatedWindows: [],
  };
  const propuesta = {
    proposalId: 'p1',
    caseId: 'c1',
    taskId: 't1',
    status: 'accepted',
    windowStart: new Date('2026-11-04T11:00:00Z'),
    windowEnd: new Date('2026-11-04T16:00:00Z'),
    expiresAt: new Date('2026-11-03T11:00:00Z'),
    task: {
      carId: 'car-1',
      plan: { name: 'VTV' },
      car: { carPatent: 'AB123CD' },
    },
    planningCase: {
      status: PlanningCaseStatus.CONFIRMED,
      projectedDueAt: new Date('2026-11-20T03:00:00Z'),
    },
  };

  beforeEach(() => {
    planner = {
      listarCasos: jest.fn().mockResolvedValue([[], 0]),
      contarPorEstado: jest.fn().mockResolvedValue({ negotiating: 0 }),
      vencimientos: jest.fn().mockResolvedValue([]),
      parametrosVigentes: jest.fn().mockResolvedValue({ params: {} }),
      cambiarParametros: jest.fn().mockResolvedValue({ params: {} }),
      ejecutar: jest.fn().mockResolvedValue({
        vehiculos: 3,
        prediccionesActualizadas: 1,
        propuestas: 2,
        escaladas: 1,
        reiteradas: 0,
        vehiculosFueraDeServicio: 0,
        enObservacion: 4,
      }),
      caso: jest.fn().mockResolvedValue(caso),
      confirmar: jest.fn().mockResolvedValue(caso),
      cancelar: jest.fn().mockResolvedValue(caso),
      forzar: jest.fn().mockResolvedValue(caso),
      replanificar: jest.fn().mockResolvedValue(caso),
      propuestasDelChofer: jest.fn().mockResolvedValue([[], 0]),
      aceptar: jest.fn().mockResolvedValue(undefined),
      rechazar: jest.fn().mockResolvedValue(undefined),
      propuestaDelChofer: jest.fn().mockResolvedValue(propuesta),
      ajustesParaElChofer: jest
        .fn()
        .mockResolvedValue({ workshopDays: [1, 2, 3, 4, 5, 6] }),
    };
    admin = new MaintenancePlannerController(
      planner as unknown as MaintenancePlannerService,
    );
    driver = new DriverMaintenanceProposalsController(
      planner as unknown as MaintenancePlannerService,
    );
  });

  it('la lista pasa los filtros y trae los totales por estado', async () => {
    const r = await admin.casos(
      {
        status: PlanningCaseStatus.ESCALATED,
        pending: true,
        limit: 5,
        offset: 10,
      },
      'd1',
    );
    expect(planner.listarCasos).toHaveBeenCalledWith('d1', {
      status: PlanningCaseStatus.ESCALATED,
      carId: undefined,
      pendientesDelAdmin: true,
      limit: 5,
      offset: 10,
    });
    expect(r).toEqual({ data: [], total: 0, counts: { negotiating: 0 } });
  });

  it('correr ahora traduce el resumen al contrato', async () => {
    expect(await admin.run('d1')).toEqual({
      vehicles: 3,
      predictionsUpdated: 1,
      proposals: 2,
      escalated: 1,
      reiterated: 0,
      groundedVehicles: 0,
      underObservation: 4,
    });
  });

  it('confirmar convierte las fechas ISO y pasa al usuario', async () => {
    await admin.confirmar(
      'c1',
      {
        windowStart: '2026-11-04T11:00:00Z',
        windowEnd: '2026-11-04T16:00:00Z',
        provider: 'Taller',
        cost: 10,
      },
      'd1',
      'u1',
    );
    expect(planner.confirmar).toHaveBeenCalledWith(
      'd1',
      'c1',
      {
        windowStart: new Date('2026-11-04T11:00:00Z'),
        windowEnd: new Date('2026-11-04T16:00:00Z'),
        provider: 'Taller',
        cost: 10,
        notes: undefined,
      },
      'u1',
    );
  });

  it('confirmar sin ventana no inventa fechas', async () => {
    await admin.confirmar('c1', {}, 'd1', 'u1');
    expect(planner.confirmar).toHaveBeenCalledWith(
      'd1',
      'c1',
      expect.objectContaining({ windowStart: undefined, windowEnd: undefined }),
      'u1',
    );
  });

  it('forzar, re-planificar y cancelar llegan al servicio con la distribuidora', async () => {
    await admin.forzar(
      't1',
      {
        windowStart: '2026-11-04T11:00:00Z',
        windowEnd: '2026-11-04T16:00:00Z',
      },
      'd1',
      'u1',
    );
    await admin.replanificar('t1', 'd1');
    await admin.cancelar('c1', { notes: 'x' }, 'd1');
    expect(planner.forzar).toHaveBeenCalledWith(
      'd1',
      't1',
      expect.objectContaining({
        windowStart: new Date('2026-11-04T11:00:00Z'),
      }),
      'u1',
    );
    expect(planner.replanificar).toHaveBeenCalledWith('d1', 't1');
    expect(planner.cancelar).toHaveBeenCalledWith('d1', 'c1', 'x');
  });

  it('el pronóstico y los parámetros se piden con la distribuidora', async () => {
    await admin.forecast({ carId: 'car-1' }, 'd1');
    await admin.settings('d1');
    await admin.settingsPatch({ topNWindows: 4 }, 'd1', 'u1');
    expect(planner.vencimientos).toHaveBeenCalledWith(
      'd1',
      { carId: 'car-1' },
      expect.any(Date),
    );
    expect(planner.cambiarParametros).toHaveBeenCalledWith(
      'd1',
      { topNWindows: 4 },
      'u1',
    );
  });

  it('el detalle de un caso viene con el cuadro', async () => {
    const r = await admin.caso('c1', 'd1');
    expect(r.windows).toEqual([]);
    expect(planner.caso).toHaveBeenCalledWith('d1', 'c1');
  });

  it('el chofer lista sus propuestas con su usuario', async () => {
    await driver.list({ limit: 20, offset: 0 }, 'u1');
    expect(planner.propuestasDelChofer).toHaveBeenCalledWith('u1', 20, 0);
  });

  it('el chofer consulta el horario y los días de taller', async () => {
    expect(await driver.settings('u1')).toEqual({
      workshopDays: [1, 2, 3, 4, 5, 6],
    });
    expect(planner.ajustesParaElChofer).toHaveBeenCalledWith('u1');
  });

  it('el chofer abre una de sus propuestas', async () => {
    const r = await driver.one('p1', 'u1');
    expect(planner.propuestaDelChofer).toHaveBeenCalledWith('u1', 'p1');
    expect(r.patent).toBe('AB123CD');
  });

  it('confirmar y fijar pasan ignoreCoverage al servicio', async () => {
    await admin.confirmar('c1', { ignoreCoverage: true }, 'd1', 'u1');
    await admin.forzar(
      't1',
      {
        windowStart: '2026-11-04T11:00:00Z',
        windowEnd: '2026-11-04T16:00:00Z',
        ignoreCoverage: true,
      },
      'd1',
      'u1',
    );
    expect(planner.confirmar).toHaveBeenCalledWith(
      'd1',
      'c1',
      expect.objectContaining({ ignoreCoverage: true }),
      'u1',
    );
    expect(planner.forzar).toHaveBeenCalledWith(
      'd1',
      't1',
      expect.objectContaining({ ignoreCoverage: true }),
      'u1',
    );
  });

  it('el chofer acepta y recibe la propuesta actualizada', async () => {
    const r = await driver.accept('p1', 'u1');
    expect(planner.aceptar).toHaveBeenCalledWith('u1', 'p1');
    expect(r.patent).toBe('AB123CD');
  });

  it('el chofer rechaza con motivo y una ventana alternativa', async () => {
    await driver.reject(
      'p1',
      {
        reason: 'No puedo',
        alternative: {
          start: '2026-11-04T11:00:00Z',
          end: '2026-11-04T14:00:00Z',
        },
      },
      'u1',
    );
    expect(planner.rechazar).toHaveBeenCalledWith('u1', 'p1', {
      reason: 'No puedo',
      alternative: {
        start: new Date('2026-11-04T11:00:00Z'),
        end: new Date('2026-11-04T14:00:00Z'),
      },
    });
  });

  it('el chofer rechaza sin alternativa', async () => {
    await driver.reject('p1', { reason: 'No puedo' }, 'u1');
    expect(planner.rechazar).toHaveBeenCalledWith('u1', 'p1', {
      reason: 'No puedo',
      alternative: undefined,
    });
  });
});
