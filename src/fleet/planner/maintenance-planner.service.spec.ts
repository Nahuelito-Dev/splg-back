import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { Car, FleetStatus } from '../../car/entities/car.entity';
import { CarService } from '../../car/car.service';
import { VehicleAssignmentService } from '../../car/vehicle-assignment.service';
import { DeliveryService } from '../../delivery/delivery.service';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { ProcessConfigService } from '../../distributor/process-config.service';
import { ESQUEMAS, valoresPorOmision } from '../../distributor/process-config';
import { ConfigurableProcess } from '../../distributor/entities/module-config.entity';
import {
  MaintenancePlanningCase,
  PlanningCaseStatus,
  PlanningEscalationReason,
  PlanningWindowSource,
} from '../entities/maintenance-planning-case.entity';
import {
  MaintenanceCriticality,
  MaintenanceDocumentKind,
  MaintenancePlan,
} from '../entities/maintenance-plan.entity';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from '../entities/maintenance-task.entity';
import {
  MaintenanceWindowProposal,
  WindowProposalStatus,
} from '../entities/maintenance-window-proposal.entity';
import { VehicleUsageLog } from '../entities/vehicle-usage-log.entity';
import { MaintenanceForecastService } from './maintenance-forecast.service';
import { MaintenancePlannerNotifier } from './maintenance-planner-notifier';
import { VehicleUsageFeedService } from './vehicle-usage-feed.service';
import { MaintenancePlannerService } from './maintenance-planner.service';
import {
  ContextoDePlanificacion,
  crearUnidadesDe,
  PlannerContextService,
} from './planner-context.service';
import { dataSourceEnMemoria, RepoEnMemoria } from './planner-test-kit';
import { sumarDias } from '../../common/utils/dias-argentina';

// Viernes 30/10/2026, 12:00 en Argentina.
const AHORA = new Date('2026-10-30T15:00:00Z');
const D1 = 'dist-1';
const D2 = 'dist-2';

const PARAMS = {
  ...valoresPorOmision(ESQUEMAS[ConfigurableProcess.FLEET_PLANNER]),
};

const dias = (n: number): Date => new Date(AHORA.getTime() + n * 86_400_000);

describe('MaintenancePlannerService', () => {
  let tasks: RepoEnMemoria<MaintenanceTask>;
  let cases: RepoEnMemoria<MaintenancePlanningCase>;
  let proposals: RepoEnMemoria<MaintenanceWindowProposal>;
  let usage: { find: jest.Mock };
  let servicio: MaintenancePlannerService;
  let carService: { findAll: jest.Mock; cambiarEstadoDeFlota: jest.Mock };
  let assignments: {
    choferDelVehiculoEn: jest.Mock;
    liberarDelVehiculo: jest.Mock;
  };
  let feed: { alimentar: jest.Mock };
  let deliveries: { findOne: jest.Mock; findOneByUserId: jest.Mock };
  let processConfig: {
    obtener: jest.Mock;
    vigentes: jest.Mock;
    guardar: jest.Mock;
  };
  let notifier: Record<
    | 'propuestaAlChofer'
    | 'propuestaCerrada'
    | 'ventanaConfirmada'
    | 'alAdminVentanaAcordada'
    | 'alAdminAcordadoPendiente'
    | 'escaladoAlChofer'
    | 'alAdminEscalado'
    | 'alAdminVehiculoFueraDeServicio',
    jest.Mock
  >;
  let contexto: { cargar: jest.Mock };
  let ctx: ContextoDePlanificacion;
  let params: Record<string, number>;
  let demanda: Record<string, number>;
  let unidades: (dia: string) => number | null;

  const plan = (over: Partial<MaintenancePlan> = {}): MaintenancePlan =>
    ({
      planId: 'plan-1',
      name: 'Service: aceite y filtros',
      leadTimeDays: 15,
      criticality: MaintenanceCriticality.NON_BLOCKING,
      documentKind: MaintenanceDocumentKind.SERVICE,
      ...over,
    }) as MaintenancePlan;

  const auto = (over: Partial<Car> = {}): Car =>
    ({
      carId: 'car-1',
      distributorId: D1,
      carPatent: 'AB123CD',
      typeCar: 'Camioneta',
      odometerKm: 10_000,
      fleetStatus: FleetStatus.ACTIVE,
      ...over,
    }) as Car;

  const chofer = (over: Partial<Delivery> = {}): Delivery =>
    ({
      deliveryId: 'del-1',
      userId: 'user-1',
      distributorId: D1,
      notificationToken: null,
      user: { email: 'chofer@example.com' },
      ...over,
    }) as Delivery;

  const tarea = (over: Partial<MaintenanceTask> = {}): MaintenanceTask => {
    const t = {
      distributorId: D1,
      carId: 'car-1',
      status: MaintenanceTaskStatus.FORECAST,
      dueAt: dias(6),
      dueKm: null,
      predictedDueAt: null,
      scheduledAt: null,
      plan: plan(),
      ...over,
    } as MaintenanceTask;
    return tasks.agregar(t);
  };

  /** Registro de uso de `n` días a `km` por día, para que la estimación sea propia. */
  const conUso = (carId: string, n: number, km: number) => {
    usage.find.mockImplementation(() =>
      Promise.resolve(
        Array.from({ length: n }, (_, i) => ({
          carId,
          day: sumarDias('2026-10-30', -i),
          km,
        })) as unknown as VehicleUsageLog[],
      ),
    );
  };

  beforeEach(() => {
    // Todos los días hábiles: las cuentas de los casos son de días corridos (los días de taller se prueban aparte).
    params = { ...PARAMS, workshopDays: 127 };
    demanda = {};
    unidades = () => null;
    cases = new RepoEnMemoria<MaintenancePlanningCase>('caseId', (c) => {
      c.car = auto({ carId: c.carId });
      c.task = tasks.filas.find(
        (t) => t.taskId === c.taskId,
      ) as MaintenanceTask;
      c.proposals = proposals.filas.filter((p) => p.caseId === c.caseId);
      c.delivery = (c.deliveryId ? chofer() : null) as Delivery;
    });
    proposals = new RepoEnMemoria<MaintenanceWindowProposal>(
      'proposalId',
      (p) => {
        p.planningCase = cases.filas.find(
          (c) => c.caseId === p.caseId,
        ) as MaintenancePlanningCase;
        p.task = tasks.filas.find(
          (t) => t.taskId === p.taskId,
        ) as MaintenanceTask;
      },
    );
    tasks = new RepoEnMemoria<MaintenanceTask>('taskId', (t) => {
      t.car = auto({ carId: t.carId as string });
    });
    Object.assign(tasks, {
      createQueryBuilder: () => {
        const qb = {
          innerJoinAndSelect: () => qb,
          where: () => qb,
          andWhere: () => qb,
          getMany: () =>
            Promise.resolve(
              tasks.filas.filter(
                (t) =>
                  t.carId &&
                  ![
                    MaintenanceTaskStatus.DONE,
                    MaintenanceTaskStatus.CANCELLED,
                  ].includes(t.status),
              ),
            ),
        };
        return qb;
      },
    });

    usage = { find: jest.fn().mockResolvedValue([]) };
    const forecast = new MaintenanceForecastService(
      usage as unknown as Repository<VehicleUsageLog>,
      tasks as unknown as Repository<MaintenanceTask>,
    );
    carService = {
      findAll: jest.fn().mockResolvedValue([auto()]),
      cambiarEstadoDeFlota: jest.fn().mockResolvedValue(undefined),
    };
    assignments = {
      choferDelVehiculoEn: jest.fn().mockResolvedValue('del-1'),
      liberarDelVehiculo: jest.fn().mockResolvedValue({ liberada: true }),
    };
    feed = {
      alimentar: jest.fn().mockResolvedValue({ vehiculos: 0, filas: 0 }),
    };
    deliveries = {
      findOne: jest.fn().mockResolvedValue(chofer()),
      findOneByUserId: jest.fn().mockResolvedValue(chofer()),
    };
    processConfig = {
      obtener: jest.fn().mockImplementation(() => Promise.resolve(params)),
      vigentes: jest.fn().mockResolvedValue({ params }),
      guardar: jest
        .fn()
        .mockImplementation((_d, _p, cuerpo: Record<string, number>) =>
          Promise.resolve({ params: cuerpo }),
        ),
    };
    notifier = {
      propuestaAlChofer: jest.fn().mockResolvedValue(undefined),
      propuestaCerrada: jest.fn(),
      ventanaConfirmada: jest.fn().mockResolvedValue(undefined),
      alAdminVentanaAcordada: jest.fn(),
      alAdminAcordadoPendiente: jest.fn(),
      escaladoAlChofer: jest.fn(),
      alAdminEscalado: jest.fn(),
      alAdminVehiculoFueraDeServicio: jest.fn(),
    };
    ctx = {
      zonaDelVehiculo: new Map(),
      vehiculosDeLaZona: new Map(),
      ocupadosPorDia: new Map(),
      demandaDe: () => Promise.resolve((dia: string) => demanda[dia] ?? 5),
      unidadesDe: () => (dia: string) => unidades(dia),
    };
    contexto = {
      cargar: jest.fn().mockImplementation(() => Promise.resolve(ctx)),
    };

    const repos = new Map<unknown, RepoEnMemoria<object>>([
      [MaintenanceTask, tasks as RepoEnMemoria<object>],
      [MaintenancePlanningCase, cases as RepoEnMemoria<object>],
      [MaintenanceWindowProposal, proposals as RepoEnMemoria<object>],
    ]);
    servicio = new MaintenancePlannerService(
      tasks as unknown as Repository<MaintenanceTask>,
      cases as unknown as Repository<MaintenancePlanningCase>,
      proposals as unknown as Repository<MaintenanceWindowProposal>,
      dataSourceEnMemoria(repos) as unknown as DataSource,
      carService as unknown as CarService,
      assignments as unknown as VehicleAssignmentService,
      deliveries as unknown as DeliveryService,
      processConfig as unknown as ProcessConfigService,
      forecast,
      contexto as unknown as PlannerContextService,
      notifier as unknown as MaintenancePlannerNotifier,
      feed as unknown as VehicleUsageFeedService,
    );
  });

  describe('acierto', () => {
    const hecha = (primera: string, hecha_: string) =>
      ({
        firstPredictedDueAt: new Date(primera),
        performedAt: new Date(hecha_),
      }) as MaintenanceTask;
    const conTareas = (filas: MaintenanceTask[]) => {
      const qb: Record<string, jest.Mock> = {};
      for (const m of ['select', 'where', 'andWhere']) {
        qb[m] = jest.fn().mockReturnValue(qb);
      }
      qb.getMany = jest.fn().mockResolvedValue(filas);
      Object.assign(tasks, { createQueryBuilder: () => qb });
      return qb;
    };

    it('mide la primera proyección contra el día en que se hizo el trabajo', async () => {
      conTareas([
        hecha('2026-10-10T15:00:00Z', '2026-10-13T15:00:00Z'),
        hecha('2026-10-20T15:00:00Z', '2026-10-18T15:00:00Z'),
        hecha('2026-10-25T15:00:00Z', '2026-11-10T15:00:00Z'),
      ]);
      const r = await servicio.acierto(
        'd1',
        undefined,
        undefined,
        new Date('2026-11-17T15:00:00Z'),
      );
      expect(r.accuracy).toEqual({
        measured: 3,
        meanAbsoluteErrorDays: 7,
        withinMarginRate: 0.67,
        marginDays: 7,
        meanBiasDays: 5.67,
      });
    });

    it('sin tareas cerradas con proyección no hay medidas', async () => {
      conTareas([]);
      const r = await servicio.acierto(
        'd1',
        '2026-10-01',
        '2026-10-31',
        new Date('2026-11-17T15:00:00Z'),
      );
      expect(r.accuracy.measured).toBe(0);
      expect(r.accuracy.meanAbsoluteErrorDays).toBeNull();
    });

    it('rechaza un período inválido', async () => {
      await expect(
        servicio.acierto('d1', '2026-13-01', undefined, new Date()),
      ).rejects.toThrow('YYYY-MM-DD');
    });
  });

  describe('ejecutar', () => {
    it('propone al chofer la ventana de menor demanda y avisa', async () => {
      const t = tarea({ dueAt: dias(6) }); // 05/11: ventanas del 31/10 al 04/11
      demanda = {
        '2026-10-31': 8,
        '2026-11-01': 1,
        '2026-11-02': 9,
        '2026-11-03': 3,
        '2026-11-04': 7,
      };

      const r = await servicio.ejecutar(D1, AHORA);

      expect(r.propuestas).toBe(1);
      expect(cases.filas).toHaveLength(1);
      expect(cases.filas[0]).toMatchObject({
        status: PlanningCaseStatus.NEGOTIATING,
        taskId: t.taskId,
        deliveryId: 'del-1',
      });
      expect(proposals.filas).toHaveLength(1);
      expect(proposals.filas[0]).toMatchObject({
        rank: 1,
        status: WindowProposalStatus.PENDING,
        deliveryId: 'del-1',
        windowStart: new Date('2026-11-01T11:00:00Z'),
        windowEnd: new Date('2026-11-01T16:00:00Z'),
      });
      expect(proposals.filas[0].expiresAt).toEqual(
        new Date(AHORA.getTime() + params.proposalTtlHours * 3_600_000),
      );
      expect(notifier.propuestaAlChofer).toHaveBeenCalledTimes(1);
    });

    it('el cuadro del caso guarda todas las ventanas evaluadas', async () => {
      tarea({ dueAt: dias(6) });
      params.topNWindows = 2;
      await servicio.ejecutar(D1, AHORA);
      const ventanas = cases.filas[0].evaluatedWindows;
      expect(ventanas).toHaveLength(5);
      expect(ventanas.filter((w) => w.offered)).toHaveLength(2);
      expect(
        ventanas.filter((w) => w.discardReason === 'not_selected'),
      ).toHaveLength(3);
    });

    it('es idempotente: otra corrida no abre otro caso ni propone de nuevo', async () => {
      tarea();
      await servicio.ejecutar(D1, AHORA);
      const segunda = await servicio.ejecutar(D1, AHORA);

      expect(segunda.propuestas).toBe(0);
      expect(cases.filas).toHaveLength(1);
      expect(proposals.filas).toHaveLength(1);
      expect(notifier.propuestaAlChofer).toHaveBeenCalledTimes(1);
    });

    it('una tarea fuera de su anticipación no se planifica', async () => {
      tarea({ dueAt: dias(40) });
      const r = await servicio.ejecutar(D1, AHORA);
      expect(r.propuestas + r.escaladas).toBe(0);
      expect(cases.filas).toHaveLength(0);
    });

    it('no planifica un trámite sin taller (el seguro) ni una tarea con taller programado', async () => {
      tarea({
        plan: plan({ documentKind: MaintenanceDocumentKind.INSURANCE }),
      });
      tarea({ scheduledAt: dias(3) });
      const r = await servicio.ejecutar(D1, AHORA);
      expect(r.propuestas + r.escaladas).toBe(0);
    });

    it('una tarea programada en el pasado sí se vuelve a planificar', async () => {
      tarea({ scheduledAt: dias(-3) });
      const r = await servicio.ejecutar(D1, AHORA);
      expect(r.propuestas).toBe(1);
    });

    it('sin chofer asignado escala al administrador desde el primer momento', async () => {
      assignments.choferDelVehiculoEn.mockResolvedValue(null);
      tarea();

      const r = await servicio.ejecutar(D1, AHORA);

      expect(r.escaladas).toBe(1);
      expect(cases.filas[0]).toMatchObject({
        status: PlanningCaseStatus.ESCALATED,
        escalationReason: PlanningEscalationReason.NO_DRIVER,
        deliveryId: null,
      });
      expect(proposals.filas).toHaveLength(0);
      expect(notifier.alAdminEscalado).toHaveBeenCalledWith(
        expect.objectContaining({ escalationReason: 'no_driver' }),
        expect.anything(),
        '2026-10-30',
        false,
      );
    });

    it('si toda ventana deja la zona bajo el mínimo, salta la negociación y escala por cobertura', async () => {
      unidades = () => 0;
      tarea();

      await servicio.ejecutar(D1, AHORA);

      expect(cases.filas[0]).toMatchObject({
        status: PlanningCaseStatus.ESCALATED,
        escalationReason: PlanningEscalationReason.COVERAGE,
      });
      expect(proposals.filas).toHaveLength(0);
      expect(
        cases.filas[0].evaluatedWindows.every(
          (w) => w.discardReason === 'coverage',
        ),
      ).toBe(true);
    });

    it('una ventana que viola la cobertura se descarta y se ofrece otra', async () => {
      unidades = (dia) => (dia === '2026-11-01' ? 0 : 3);
      demanda = { '2026-11-01': 0 };
      tarea({ dueAt: dias(6) });

      await servicio.ejecutar(D1, AHORA);

      expect(proposals.filas[0].windowStart.toISOString()).not.toContain(
        '2026-11-01',
      );
    });

    it('sin ventana en el horizonte escala por falta de ventanas', async () => {
      params.horizonDays = 1;
      params.minLeadDays = 2;
      tarea({ dueAt: dias(1) });
      await servicio.ejecutar(D1, AHORA);
      expect(cases.filas[0]).toMatchObject({
        status: PlanningCaseStatus.ESCALATED,
        escalationReason: PlanningEscalationReason.NO_WINDOWS,
      });
    });

    it('reitera el aviso de un caso escalado en cada corrida, sin abrir otro', async () => {
      assignments.choferDelVehiculoEn.mockResolvedValue(null);
      tarea();
      await servicio.ejecutar(D1, AHORA);
      notifier.alAdminEscalado.mockClear();

      const r = await servicio.ejecutar(D1, dias(1));

      expect(r.reiteradas).toBe(1);
      expect(cases.filas).toHaveLength(1);
      expect(notifier.alAdminEscalado).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        '2026-10-31',
        true,
      );
    });

    it('por kilometraje proyecta con el uso real y guarda predicted_due_at', async () => {
      conUso('car-1', 60, 100); // 100 km/día
      const t = tarea({
        dueAt: null,
        dueKm: 11_000,
        plan: plan({ leadTimeDays: 30 }),
      });
      // 1000 km a 100 km/día = 10 días: entra en la anticipación de 30.
      const r = await servicio.ejecutar(D1, AHORA);

      expect(t.predictedDueAt).toEqual(dias(10));
      expect(r.prediccionesActualizadas).toBe(1);
      expect(r.propuestas).toBe(1);
    });

    it('uso bajo: la misma tarea por km queda fuera de la anticipación', async () => {
      conUso('car-1', 60, 5); // 5 km/día
      const t = tarea({
        dueAt: null,
        dueKm: 11_000,
        plan: plan({ leadTimeDays: 30 }),
      });
      const r = await servicio.ejecutar(D1, AHORA);

      expect(t.predictedDueAt).toEqual(dias(200));
      expect(r.propuestas).toBe(0);
    });

    it('sin uso ni promedio de la flota la tarea por km queda en observación y no se planifica', async () => {
      tarea({ dueAt: null, dueKm: 11_000 });
      const r = await servicio.ejecutar(D1, AHORA);
      expect(r.enObservacion).toBe(1);
      expect(cases.filas).toHaveLength(0);
    });

    it('con una habilitación bloqueante vencida deja el vehículo fuera de servicio', async () => {
      tarea({
        dueAt: dias(-5),
        plan: plan({
          name: 'VTV',
          criticality: MaintenanceCriticality.BLOCKING,
          documentKind: MaintenanceDocumentKind.VTV,
        }),
      });

      const r = await servicio.ejecutar(D1, AHORA);

      expect(r.vehiculosFueraDeServicio).toBe(1);
      expect(carService.cambiarEstadoDeFlota).toHaveBeenCalledWith(
        expect.anything(),
        'car-1',
        D1,
        FleetStatus.GROUNDED,
        FleetStatus.ACTIVE,
      );
      expect(notifier.alAdminVehiculoFueraDeServicio).toHaveBeenCalled();
    });

    it('una tarea no bloqueante vencida no deja el vehículo fuera de servicio', async () => {
      tarea({ dueAt: dias(-5) });
      const r = await servicio.ejecutar(D1, AHORA);
      expect(r.vehiculosFueraDeServicio).toBe(0);
    });

    it('sigue con las demás tareas si una falla', async () => {
      carService.findAll.mockResolvedValue([auto(), auto({ carId: 'car-2' })]);
      tarea({ carId: 'car-1' });
      tarea({ carId: 'car-2' });
      assignments.choferDelVehiculoEn
        .mockRejectedValueOnce(new Error('se cayó'))
        .mockResolvedValue('del-1');

      const r = await servicio.ejecutar(D1, AHORA);

      expect(r.propuestas).toBe(1);
    });
  });

  describe('respuesta del chofer', () => {
    /** Un caso negociando con tres ventanas y la primera ya propuesta. */
    const caso = async () => {
      tarea({ dueAt: dias(6) });
      demanda = {
        '2026-10-31': 1,
        '2026-11-01': 2,
        '2026-11-02': 3,
        '2026-11-03': 9,
        '2026-11-04': 9,
      };
      await servicio.ejecutar(D1, AHORA);
      return {
        caso: cases.filas[0],
        propuesta: proposals.filas[0],
      };
    };

    it('aceptar deja el caso a la espera del administrador y le avisa', async () => {
      const { caso: c, propuesta } = await caso();

      await servicio.aceptar('user-1', propuesta.proposalId, AHORA);

      expect(propuesta).toMatchObject({
        status: WindowProposalStatus.ACCEPTED,
        respondedAt: AHORA,
      });
      expect(c).toMatchObject({
        status: PlanningCaseStatus.AWAITING_CONFIRMATION,
        chosenStart: propuesta.windowStart,
        chosenSource: PlanningWindowSource.DRIVER_ACCEPTED,
      });
      expect(notifier.alAdminVentanaAcordada).toHaveBeenCalledWith(
        c,
        expect.anything(),
        false,
      );
    });

    it('la tarea no queda programada hasta que el administrador confirme', async () => {
      const { propuesta } = await caso();
      await servicio.aceptar('user-1', propuesta.proposalId, AHORA);
      expect(tasks.filas[0].scheduledAt).toBeNull();
      expect(tasks.filas[0].status).toBe(MaintenanceTaskStatus.FORECAST);
    });

    it('la propuesta de otro chofer es un 404', async () => {
      const { propuesta } = await caso();
      deliveries.findOneByUserId.mockResolvedValue(
        chofer({ deliveryId: 'del-2', userId: 'user-2' }),
      );

      await expect(
        servicio.aceptar('user-2', propuesta.proposalId, AHORA),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(propuesta.status).toBe(WindowProposalStatus.PENDING);
    });

    it('rechazar con motivo ofrece la ventana siguiente', async () => {
      const { propuesta } = await caso();

      await servicio.rechazar(
        'user-1',
        propuesta.proposalId,
        { reason: ' Tengo turno médico ' },
        AHORA,
      );

      expect(propuesta).toMatchObject({
        status: WindowProposalStatus.REJECTED,
        rejectionReason: 'Tengo turno médico',
      });
      expect(proposals.filas).toHaveLength(2);
      expect(proposals.filas[1]).toMatchObject({
        rank: 2,
        status: WindowProposalStatus.PENDING,
      });
      expect(proposals.filas[1].windowStart.getTime()).toBeGreaterThan(
        propuesta.windowStart.getTime(),
      );
      expect(notifier.propuestaAlChofer).toHaveBeenCalledTimes(2);
    });

    it('rechazar sin motivo es un 400 y no toca la propuesta', async () => {
      const { propuesta } = await caso();
      await expect(
        servicio.rechazar(
          'user-1',
          propuesta.proposalId,
          { reason: '   ' },
          AHORA,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(propuesta.status).toBe(WindowProposalStatus.PENDING);
    });

    it('si rechaza todas las alternativas escala al administrador', async () => {
      const { caso: c } = await caso();
      for (let i = 0; i < params.topNWindows; i += 1) {
        const pendiente = proposals.filas.find(
          (p) => p.status === WindowProposalStatus.PENDING,
        ) as MaintenanceWindowProposal;
        await servicio.rechazar(
          'user-1',
          pendiente.proposalId,
          { reason: 'No puedo' },
          AHORA,
        );
      }

      expect(proposals.filas).toHaveLength(params.topNWindows);
      expect(c).toMatchObject({
        status: PlanningCaseStatus.ESCALATED,
        escalationReason: PlanningEscalationReason.EXHAUSTED,
      });
      expect(notifier.alAdminEscalado).toHaveBeenCalledWith(
        c,
        expect.anything(),
        '2026-10-30',
        false,
      );
    });

    it('una alternativa viable queda acordada a la espera del administrador', async () => {
      const { caso: c, propuesta } = await caso();
      const alternativa = {
        start: new Date('2026-11-02T11:00:00Z'),
        end: new Date('2026-11-02T14:00:00Z'),
      };

      await servicio.rechazar(
        'user-1',
        propuesta.proposalId,
        { reason: 'Prefiero el lunes', alternative: alternativa },
        AHORA,
      );

      expect(propuesta).toMatchObject({
        altWindowStart: alternativa.start,
        altWindowEnd: alternativa.end,
      });
      expect(c).toMatchObject({
        status: PlanningCaseStatus.AWAITING_CONFIRMATION,
        chosenStart: alternativa.start,
        chosenSource: PlanningWindowSource.DRIVER_ALTERNATIVE,
      });
      expect(proposals.filas).toHaveLength(1);
      expect(notifier.alAdminVentanaAcordada).toHaveBeenCalledWith(
        c,
        expect.anything(),
        true,
      );
    });

    it.each([
      [
        'fuera del horario de taller',
        {
          start: new Date('2026-11-02T22:00:00Z'),
          end: new Date('2026-11-03T00:00:00Z'),
        },
      ],
      [
        'en dos días distintos',
        {
          start: new Date('2026-11-02T11:00:00Z'),
          end: new Date('2026-11-03T14:00:00Z'),
        },
      ],
      [
        'invertida',
        {
          start: new Date('2026-11-02T14:00:00Z'),
          end: new Date('2026-11-02T11:00:00Z'),
        },
      ],
      [
        'después del vencimiento',
        {
          start: new Date('2026-11-09T11:00:00Z'),
          end: new Date('2026-11-09T14:00:00Z'),
        },
      ],
      [
        'hoy, sin el aviso mínimo',
        {
          start: new Date('2026-10-30T20:00:00Z'),
          end: new Date('2026-10-30T21:00:00Z'),
        },
      ],
    ])(
      'una alternativa %s es un 400 y la propuesta sigue vigente',
      async (_caso, alt) => {
        const { propuesta } = await caso();
        await expect(
          servicio.rechazar(
            'user-1',
            propuesta.proposalId,
            { reason: 'No puedo', alternative: alt },
            AHORA,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(propuesta.status).toBe(WindowProposalStatus.PENDING);
      },
    );

    it('una alternativa que deja la zona bajo el mínimo es un 400', async () => {
      const { propuesta } = await caso();
      unidades = () => 0;
      await expect(
        servicio.rechazar(
          'user-1',
          propuesta.proposalId,
          {
            reason: 'No puedo',
            alternative: {
              start: new Date('2026-11-02T11:00:00Z'),
              end: new Date('2026-11-02T14:00:00Z'),
            },
          },
          AHORA,
        ),
      ).rejects.toThrow('zona de cobertura');
    });

    it('responder una propuesta ya respondida es un 409', async () => {
      const { propuesta } = await caso();
      await servicio.aceptar('user-1', propuesta.proposalId, AHORA);
      await expect(
        servicio.aceptar('user-1', propuesta.proposalId, AHORA),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('responder una propuesta vencida es un 409', async () => {
      const { propuesta } = await caso();
      const tarde = new Date(propuesta.expiresAt.getTime() + 1000);
      await expect(
        servicio.aceptar('user-1', propuesta.proposalId, tarde),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(propuesta.status).toBe(WindowProposalStatus.PENDING);
    });

    it('lista las propuestas del chofer: la vigente primero y después de la más próxima a la más lejana', async () => {
      await caso();
      const orden: unknown[][] = [];
      const qb = {
        innerJoinAndSelect: () => qb,
        leftJoinAndSelect: () => qb,
        withDeleted: () => qb,
        where: () => qb,
        addSelect: (expresion: string) => {
          orden.push(['select', expresion]);
          return qb;
        },
        orderBy: (campo: string, sentido: string) => {
          orden.push(['order', campo, sentido]);
          return qb;
        },
        addOrderBy: (campo: string, sentido: string) => {
          orden.push(['order', campo, sentido]);
          return qb;
        },
        getCount: () => Promise.resolve(1),
        limit: () => qb,
        offset: () => qb,
        getMany: () => Promise.resolve(proposals.filas),
      };
      Object.assign(proposals, { createQueryBuilder: () => qb });
      const [lista, total] = await servicio.propuestasDelChofer(
        'user-1',
        10,
        0,
      );
      expect(total).toBe(1);
      expect(lista[0].status).toBe(WindowProposalStatus.PENDING);
      expect(orden).toEqual([
        ['select', "CASE WHEN p.status = 'pending' THEN 0 ELSE 1 END"],
        ['order', 'orden', 'ASC'],
        ['order', 'p.windowStart', 'ASC'],
        ['order', 'p.rank', 'ASC'],
      ]);
    });
  });

  describe('vencerPropuestas', () => {
    const caso = async () => {
      tarea({ dueAt: dias(6) });
      await servicio.ejecutar(D1, AHORA);
      return { caso: cases.filas[0], propuesta: proposals.filas[0] };
    };

    it('vence la que pasó su vigencia y ofrece la siguiente', async () => {
      const { propuesta } = await caso();
      const despues = new Date(propuesta.expiresAt.getTime() + 60_000);

      const n = await servicio.vencerPropuestas(despues);

      expect(n).toBe(1);
      expect(propuesta.status).toBe(WindowProposalStatus.EXPIRED);
      expect(propuesta.respondedAt).toBeNull();
      expect(proposals.filas).toHaveLength(2);
      expect(proposals.filas[1]).toMatchObject({
        rank: 2,
        status: WindowProposalStatus.PENDING,
      });
      expect(notifier.propuestaCerrada).toHaveBeenCalledWith(
        'user-1',
        propuesta.proposalId,
        'expired',
      );
    });

    it('no toca la que sigue vigente', async () => {
      const { propuesta } = await caso();
      const n = await servicio.vencerPropuestas(AHORA);
      expect(n).toBe(0);
      expect(propuesta.status).toBe(WindowProposalStatus.PENDING);
    });

    it('si vencen todas las alternativas escala', async () => {
      const { caso: c } = await caso();
      let reloj = AHORA;
      for (let i = 0; i < params.topNWindows; i += 1) {
        const pendiente = proposals.filas.find(
          (p) => p.status === WindowProposalStatus.PENDING,
        ) as MaintenanceWindowProposal;
        reloj = new Date(pendiente.expiresAt.getTime() + 1000);
        await servicio.vencerPropuestas(reloj);
      }
      expect(c).toMatchObject({
        status: PlanningCaseStatus.ESCALATED,
        escalationReason: PlanningEscalationReason.EXHAUSTED,
      });
      expect(
        proposals.filas.every((p) => p.status === WindowProposalStatus.EXPIRED),
      ).toBe(true);
    });

    it('salta las ventanas que ya empezaron', async () => {
      const { caso: c, propuesta } = await caso();
      // La vigencia pasa cuando la segunda ventana ya empezó: queda la tercera.
      const segunda = new Date(
        c.evaluatedWindows.filter((w) => w.offered)[1].start,
      );
      await servicio.vencerPropuestas(
        new Date(
          Math.max(propuesta.expiresAt.getTime(), segunda.getTime()) + 1000,
        ),
      );
      const ultima = proposals.filas[proposals.filas.length - 1];
      const tercera = c.evaluatedWindows.filter((w) => w.offered)[2];
      expect(ultima.windowStart.toISOString()).toBe(tercera.start);
      expect(ultima.rank).toBe(2);
    });
  });

  describe('administrador', () => {
    const acordado = async () => {
      tarea({ dueAt: dias(6) });
      await servicio.ejecutar(D1, AHORA);
      await servicio.aceptar('user-1', proposals.filas[0].proposalId, AHORA);
      return cases.filas[0];
    };

    it('confirmar programa la tarea con la ventana acordada y avisa al chofer', async () => {
      const c = await acordado();

      await servicio.confirmar(
        D1,
        c.caseId,
        { provider: 'Taller Los Pinos', cost: 85000 },
        'admin-1',
        AHORA,
      );

      expect(c).toMatchObject({
        status: PlanningCaseStatus.CONFIRMED,
        resolvedAt: AHORA,
        resolvedByUserId: 'admin-1',
      });
      expect(tasks.filas[0]).toMatchObject({
        status: MaintenanceTaskStatus.SCHEDULED,
        scheduledAt: c.chosenStart,
        provider: 'Taller Los Pinos',
        cost: 85000,
      });
      expect(notifier.ventanaConfirmada).toHaveBeenCalled();
    });

    it('una tarea confirmada no se vuelve a planificar', async () => {
      const c = await acordado();
      await servicio.confirmar(D1, c.caseId, {}, 'admin-1', AHORA);
      const r = await servicio.ejecutar(D1, AHORA);
      expect(r.propuestas + r.escaladas).toBe(0);
      expect(cases.filas).toHaveLength(1);
    });

    it('elegir otra ventana resuelve un caso escalado', async () => {
      assignments.choferDelVehiculoEn.mockResolvedValue(null);
      tarea();
      await servicio.ejecutar(D1, AHORA);
      const c = cases.filas[0];
      const ventana = { windowStart: dias(3), windowEnd: dias(3.2) };

      await expect(
        servicio.confirmar(D1, c.caseId, {}, 'admin-1', AHORA),
      ).rejects.toBeInstanceOf(BadRequestException);
      await servicio.confirmar(D1, c.caseId, ventana, 'admin-1', AHORA);

      expect(c).toMatchObject({
        status: PlanningCaseStatus.CONFIRMED,
        chosenSource: PlanningWindowSource.ADMIN,
      });
      expect(tasks.filas[0].scheduledAt).toEqual(ventana.windowStart);
    });

    it('confirmar cancela la propuesta que seguía esperando al chofer', async () => {
      tarea({ dueAt: dias(6) });
      await servicio.ejecutar(D1, AHORA);
      const c = cases.filas[0];

      await servicio.confirmar(
        D1,
        c.caseId,
        { windowStart: dias(2), windowEnd: dias(2.2) },
        'admin-1',
        AHORA,
      );

      expect(proposals.filas[0].status).toBe(WindowProposalStatus.CANCELLED);
      expect(notifier.propuestaCerrada).toHaveBeenCalledWith(
        'user-1',
        proposals.filas[0].proposalId,
        'resolved',
      );
    });

    it.each([
      ['una ventana pasada', { windowStart: dias(-2), windowEnd: dias(-1) }],
      ['una ventana invertida', { windowStart: dias(3), windowEnd: dias(2) }],
      ['sólo el inicio', { windowStart: dias(3) }],
    ])('rechaza %s', async (_nombre, resolucion) => {
      const c = await acordado();
      await expect(
        servicio.confirmar(D1, c.caseId, resolucion, 'admin-1', AHORA),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(c.status).toBe(PlanningCaseStatus.AWAITING_CONFIRMATION);
    });

    it('no se resuelve dos veces', async () => {
      const c = await acordado();
      await servicio.confirmar(D1, c.caseId, {}, 'admin-1', AHORA);
      await expect(
        servicio.confirmar(D1, c.caseId, {}, 'admin-1', AHORA),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('un caso de otra distribuidora no existe', async () => {
      const c = await acordado();
      await expect(
        servicio.confirmar(D2, c.caseId, {}, 'admin-2', AHORA),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        servicio.cancelar(D2, c.caseId, undefined, AHORA),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(c.status).toBe(PlanningCaseStatus.AWAITING_CONFIRMATION);
    });

    it('cancelar cierra el caso y su propuesta vigente sin programar la tarea', async () => {
      tarea({ dueAt: dias(6) });
      await servicio.ejecutar(D1, AHORA);
      const c = cases.filas[0];

      await servicio.cancelar(D1, c.caseId, 'Sale de la flota', AHORA);

      expect(c).toMatchObject({
        status: PlanningCaseStatus.CANCELLED,
        notes: 'Sale de la flota',
      });
      expect(proposals.filas[0].status).toBe(WindowProposalStatus.CANCELLED);
      expect(tasks.filas[0].scheduledAt).toBeNull();
      await expect(
        servicio.cancelar(D1, c.caseId, undefined, AHORA),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('forzar sin caso abre uno ya confirmado', async () => {
      const t = tarea();
      const ventana = { windowStart: dias(4), windowEnd: dias(4.2) };

      const c = await servicio.forzar(D1, t.taskId, ventana, 'admin-1', AHORA);

      expect(c.status).toBe(PlanningCaseStatus.CONFIRMED);
      expect(t).toMatchObject({
        status: MaintenanceTaskStatus.SCHEDULED,
        scheduledAt: ventana.windowStart,
      });
    });

    it('forzar sobre un caso abierto lo resuelve en lugar de abrir otro', async () => {
      const t = tarea({ dueAt: dias(6) });
      await servicio.ejecutar(D1, AHORA);

      await servicio.forzar(
        D1,
        t.taskId,
        { windowStart: dias(3), windowEnd: dias(3.2) },
        'admin-1',
        AHORA,
      );

      expect(cases.filas).toHaveLength(1);
      expect(cases.filas[0].status).toBe(PlanningCaseStatus.CONFIRMED);
    });

    it('no fija ventana en una tarea cerrada ni de otra distribuidora', async () => {
      const cerrada = tarea({ status: MaintenanceTaskStatus.DONE });
      const ventana = { windowStart: dias(3), windowEnd: dias(3.2) };
      await expect(
        servicio.forzar(D1, cerrada.taskId, ventana, 'a', AHORA),
      ).rejects.toBeInstanceOf(ConflictException);
      const ajena = tarea({ distributorId: D2 });
      await expect(
        servicio.forzar(D1, ajena.taskId, ventana, 'a', AHORA),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('re-planificar cancela el caso abierto y propone de nuevo', async () => {
      const t = tarea({ dueAt: dias(6) });
      await servicio.ejecutar(D1, AHORA);
      const primero = cases.filas[0];

      await servicio.replanificar(D1, t.taskId, AHORA);

      expect(primero.status).toBe(PlanningCaseStatus.CANCELLED);
      expect(cases.filas).toHaveLength(2);
      expect(cases.filas[1].status).toBe(PlanningCaseStatus.NEGOTIATING);
      expect(
        proposals.filas.filter(
          (p) => p.status === WindowProposalStatus.PENDING,
        ),
      ).toHaveLength(1);
    });

    it('re-planificar un trámite sin taller es un 400', async () => {
      const t = tarea({
        plan: plan({ documentKind: MaintenanceDocumentKind.INSURANCE }),
      });
      await expect(
        servicio.replanificar(D1, t.taskId, AHORA),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cambiarParametros guarda todo con los cambios aplicados sobre lo vigente', async () => {
      await servicio.cambiarParametros(
        D1,
        { topNWindows: 5, cronHour: undefined },
        'admin-1',
      );
      expect(processConfig.guardar).toHaveBeenCalledWith(
        D1,
        ConfigurableProcess.FLEET_PLANNER,
        { ...PARAMS, workshopDays: 127, topNWindows: 5 },
        'admin-1',
      );
    });
  });

  describe('vencimientos', () => {
    it('muestra la proyección de cada tarea con el consumo que la explica', async () => {
      conUso('car-1', 60, 100);
      tarea({ dueAt: null, dueKm: 11_000, plan: plan({ leadTimeDays: 30 }) });
      tarea({
        plan: plan({
          documentKind: MaintenanceDocumentKind.INSURANCE,
          name: 'Seguro',
        }),
        dueAt: dias(90),
      });

      const [v] = await servicio.vencimientos(D1, {}, AHORA);

      expect(v.consumo?.source).toBe('own');
      expect(v.consumo?.kmPorDia).toBeCloseTo(100, 3);
      expect(v.items[0].proyeccion.fecha).toEqual(dias(10));
      expect(v.items[0].porVencer).toBe(true);
      expect(v.items[1].porVencer).toBe(false);
    });

    it('la próxima ventana es la de la tarea programada', async () => {
      tarea({ scheduledAt: dias(4) });
      const [v] = await servicio.vencimientos(D1, {}, AHORA);
      expect(v.proximaVentana).toMatchObject({
        estado: PlanningCaseStatus.CONFIRMED,
        start: dias(4),
      });
    });

    it('la próxima ventana incluye la propuesta que espera al chofer', async () => {
      tarea({ dueAt: dias(6) });
      await servicio.ejecutar(D1, AHORA);
      const [v] = await servicio.vencimientos(D1, {}, AHORA);
      expect(v.proximaVentana?.estado).toBe(PlanningCaseStatus.NEGOTIATING);
      expect(v.proximaVentana?.start).toEqual(proposals.filas[0].windowStart);
    });
  });

  describe('ronda 2', () => {
    /** Una zona de tres vehículos (A, B y C) con la cobertura calculada de verdad. */
    const zonaDeTres = () => {
      const zona = new Map([
        ['car-1', 'z1'],
        ['car-2', 'z1'],
        ['car-3', 'z1'],
      ]);
      const deLaZona = new Map([['z1', new Set(['car-1', 'car-2', 'car-3'])]]);
      const ocupados = new Map<string, Set<string>>();
      ctx = {
        zonaDelVehiculo: zona,
        vehiculosDeLaZona: deLaZona,
        ocupadosPorDia: ocupados,
        demandaDe: () => Promise.resolve((dia: string) => demanda[dia] ?? 5),
        unidadesDe: (carId) => crearUnidadesDe(zona, deLaZona, ocupados, carId),
      };
      carService.findAll.mockResolvedValue([
        auto({ carId: 'car-1' }),
        auto({ carId: 'car-2', carPatent: 'BB222BB' }),
        auto({ carId: 'car-3', carPatent: 'CC333CC' }),
      ]);
      params.minVehiclesPerZone = 2;
      return ocupados;
    };

    describe('A2: cobertura mínima de la zona', () => {
      it('la propuesta de A reserva el día: B no recibe la misma ventana en la misma corrida', async () => {
        zonaDeTres();
        demanda = {
          '2026-10-31': 0,
          '2026-11-01': 1,
          '2026-11-02': 2,
          '2026-11-03': 3,
          '2026-11-04': 4,
        };
        tarea({ carId: 'car-1', dueAt: dias(6) });
        tarea({ carId: 'car-2', dueAt: dias(6) });
        assignments.choferDelVehiculoEn.mockImplementation((carId: string) =>
          Promise.resolve(carId === 'car-1' ? 'del-1' : 'del-2'),
        );
        deliveries.findOne.mockImplementation((id: string) =>
          Promise.resolve(chofer({ deliveryId: id, userId: `user-${id}` })),
        );

        await servicio.ejecutar(D1, AHORA);

        const deA = proposals.filas.find((p) => p.deliveryId === 'del-1');
        const deB = proposals.filas.find((p) => p.deliveryId === 'del-2');
        expect(deA?.windowStart.toISOString()).toContain('2026-10-31');
        // B también prefería el 31/10 (demanda 0), pero con A en el taller la zona quedaría con 1 < 2.
        expect(deB?.windowStart.toISOString()).not.toContain('2026-10-31');
        const casoB = cases.filas.find((c) => c.carId === 'car-2');
        expect(
          casoB?.evaluatedWindows.find((w) => w.start.includes('2026-10-31')),
        ).toMatchObject({
          offered: false,
          discardReason: 'coverage',
          unitsLeft: 1,
        });
      });

      it('aceptar una ventana que otro vehículo ya ocupó es un 409 con el motivo', async () => {
        const ocupados = zonaDeTres();
        tarea({ carId: 'car-1', dueAt: dias(6) });
        await servicio.ejecutar(D1, AHORA);
        const propuesta = proposals.filas[0];
        // Mientras tanto B quedó con el taller acordado ese mismo día.
        ocupados.set('2026-10-31', new Set(['car-2']));
        propuesta.windowStart = new Date('2026-10-31T11:00:00Z');

        await expect(
          servicio.aceptar('user-1', propuesta.proposalId, AHORA),
        ).rejects.toThrow(/por debajo del mínimo de 2/);
        expect(propuesta.status).toBe(WindowProposalStatus.PENDING);
      });

      it('confirmar también lo vuelve a chequear, salvo que el administrador lo decida', async () => {
        const ocupados = zonaDeTres();
        tarea({ carId: 'car-1', dueAt: dias(6) });
        await servicio.ejecutar(D1, AHORA);
        await servicio.aceptar('user-1', proposals.filas[0].proposalId, AHORA);
        const c = cases.filas[0];
        ocupados.set('2026-10-31', new Set(['car-2']));
        c.chosenStart = new Date('2026-10-31T11:00:00Z');
        c.chosenEnd = new Date('2026-10-31T16:00:00Z');

        await expect(
          servicio.confirmar(D1, c.caseId, {}, 'admin-1', AHORA),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(c.status).toBe(PlanningCaseStatus.AWAITING_CONFIRMATION);

        await servicio.confirmar(
          D1,
          c.caseId,
          { ignoreCoverage: true },
          'admin-1',
          AHORA,
        );
        expect(c.status).toBe(PlanningCaseStatus.CONFIRMED);
      });

      it('un vehículo dejado fuera de servicio no cuenta para la cobertura de la corrida', async () => {
        carService.findAll.mockResolvedValue([
          auto(),
          auto({ carId: 'car-2' }),
        ]);
        tarea({
          carId: 'car-2',
          dueAt: dias(-5),
          plan: plan({
            name: 'VTV',
            criticality: MaintenanceCriticality.BLOCKING,
            documentKind: MaintenanceDocumentKind.VTV,
          }),
        });
        tarea({ carId: 'car-1', dueAt: dias(6) });
        await servicio.ejecutar(D1, AHORA);
        const activosPasados = (
          contexto.cargar.mock.calls[0] as [string, Car[]]
        )[1];
        expect(activosPasados.map((c) => c.carId)).toEqual(['car-1']);
      });
    });

    describe('A3: vehículo dado de baja', () => {
      it('si revisar un caso falla (p. ej. su vehículo ya no se lee) no tumba la corrida ni los demás casos', async () => {
        assignments.choferDelVehiculoEn.mockResolvedValue(null);
        carService.findAll.mockResolvedValue([
          auto(),
          auto({ carId: 'car-2' }),
        ]);
        tarea({ carId: 'car-1' });
        tarea({ carId: 'car-2' });
        await servicio.ejecutar(D1, AHORA);
        notifier.alAdminEscalado.mockClear();
        notifier.alAdminEscalado.mockImplementationOnce(() => {
          throw new Error(
            'Cannot read properties of undefined (reading carPatent)',
          );
        });

        const r = await servicio.ejecutar(D1, dias(1));

        expect(notifier.alAdminEscalado).toHaveBeenCalledTimes(2);
        expect(r.reiteradas).toBe(1);
      });
    });

    describe('B3 y B1: avisos al administrador', () => {
      it('el día del escalamiento no se reitera: un solo aviso por día', async () => {
        assignments.choferDelVehiculoEn.mockResolvedValue(null);
        tarea();
        await servicio.ejecutar(D1, AHORA);
        notifier.alAdminEscalado.mockClear();
        const r = await servicio.ejecutar(
          D1,
          new Date(AHORA.getTime() + 3_600_000),
        );
        expect(r.reiteradas).toBe(0);
        expect(notifier.alAdminEscalado).not.toHaveBeenCalled();
      });

      it('un acordado sin confirmar se reitera cada día y no abre un caso duplicado', async () => {
        tarea({ dueAt: dias(6) });
        await servicio.ejecutar(D1, AHORA);
        await servicio.aceptar('user-1', proposals.filas[0].proposalId, AHORA);
        const r = await servicio.ejecutar(D1, dias(1));
        expect(r.reiteradas).toBe(1);
        expect(r.propuestas + r.escaladas).toBe(0);
        expect(cases.filas).toHaveLength(1);
        expect(notifier.alAdminAcordadoPendiente).toHaveBeenCalledWith(
          cases.filas[0],
          expect.anything(),
          '2026-10-31',
        );
      });
    });

    describe('M3: ventana acordada que ya pasó', () => {
      it('confirmarla es un 400 que pide elegir otra', async () => {
        tarea({ dueAt: dias(6) });
        await servicio.ejecutar(D1, AHORA);
        await servicio.aceptar('user-1', proposals.filas[0].proposalId, AHORA);
        const despues = new Date(
          cases.filas[0].chosenStart!.getTime() + 3_600_000,
        );
        await expect(
          servicio.confirmar(D1, cases.filas[0].caseId, {}, 'admin-1', despues),
        ).rejects.toThrow(/ya pasó: elegí otra/);
        expect(cases.filas[0].status).toBe(
          PlanningCaseStatus.AWAITING_CONFIRMATION,
        );
      });
    });

    describe('M4: lo urgente se negocia igual', () => {
      it('una tarea vencida recibe ventanas desde el primer día hábil, marcadas urgentes', async () => {
        tarea({ dueAt: dias(-3) });
        const r = await servicio.ejecutar(D1, AHORA);
        expect(r.propuestas).toBe(1);
        expect(proposals.filas[0].windowStart.toISOString()).toContain(
          '2026-10-31',
        );
        expect(cases.filas[0].evaluatedWindows.every((w) => w.urgent)).toBe(
          true,
        );
      });

      it('lo urgente se ofrece por fecha aunque otro día tenga menos demanda', async () => {
        demanda = { '2026-10-31': 50, '2026-11-01': 0 };
        tarea({ dueAt: dias(-3) });
        await servicio.ejecutar(D1, AHORA);
        expect(proposals.filas[0].windowStart.toISOString()).toContain(
          '2026-10-31',
        );
      });
    });

    describe('M5: días hábiles del taller', () => {
      it('por omisión no se ofrecen domingos ni feriados', async () => {
        params.workshopDays = 126; // lunes a sábado
        params.topNWindows = 10;
        tarea({ dueAt: dias(9) });
        await servicio.ejecutar(D1, AHORA);
        const dias_ = cases.filas[0].evaluatedWindows.map((w) =>
          w.start.slice(0, 10),
        );
        expect(dias_).not.toContain('2026-11-01'); // domingo
        expect(dias_).toContain('2026-11-02');
      });

      it('un feriado se saltea aunque el taller atienda ese día de la semana', async () => {
        params.workshopDays = 127;
        params.topNWindows = 10;
        const ahoraNov = new Date('2026-11-20T15:00:00Z');
        tarea({ dueAt: new Date('2026-11-27T00:00:00Z') });
        await servicio.ejecutar(D1, ahoraNov);
        const dias_ = cases.filas[0].evaluatedWindows.map((w) =>
          w.start.slice(0, 10),
        );
        expect(dias_).not.toContain('2026-11-23');
        expect(dias_).toContain('2026-11-24');
      });
    });

    describe('M6: el chofer es el de la asignación vigente', () => {
      it('si cambió el chofer, la propuesta del anterior se cierra con aviso y la nueva va al actual', async () => {
        tarea({ dueAt: dias(6) });
        await servicio.ejecutar(D1, AHORA);
        const vieja = proposals.filas[0];
        assignments.choferDelVehiculoEn.mockResolvedValue('del-2');
        deliveries.findOne.mockImplementation((id: string) =>
          Promise.resolve(chofer({ deliveryId: id, userId: `user-${id}` })),
        );

        await servicio.ejecutar(D1, AHORA);

        expect(vieja.status).toBe(WindowProposalStatus.CANCELLED);
        expect(notifier.propuestaCerrada).toHaveBeenCalledWith(
          'user-del-1',
          vieja.proposalId,
          'cancelled',
        );
        const nueva = proposals.filas.find(
          (p) => p.status === WindowProposalStatus.PENDING,
        );
        expect(nueva).toMatchObject({ deliveryId: 'del-2' });
        expect(nueva?.windowStart).toEqual(vieja.windowStart); // se le ofrece la misma ventana
        expect(cases.filas[0].deliveryId).toBe('del-2');
        expect(notifier.propuestaAlChofer).toHaveBeenLastCalledWith(
          expect.objectContaining({ deliveryId: 'del-2' }),
          nueva,
          expect.anything(),
          false,
        );
      });

      it('si el vehículo quedó sin chofer, cierra la propuesta y escala', async () => {
        tarea({ dueAt: dias(6) });
        await servicio.ejecutar(D1, AHORA);
        assignments.choferDelVehiculoEn.mockResolvedValue(null);
        await servicio.ejecutar(D1, AHORA);
        expect(proposals.filas[0].status).toBe(WindowProposalStatus.CANCELLED);
        expect(cases.filas[0]).toMatchObject({
          status: PlanningCaseStatus.ESCALATED,
          escalationReason: PlanningEscalationReason.NO_DRIVER,
        });
      });

      it('al vencer una propuesta la siguiente va al chofer de hoy', async () => {
        tarea({ dueAt: dias(6) });
        await servicio.ejecutar(D1, AHORA);
        assignments.choferDelVehiculoEn.mockResolvedValue('del-9');
        deliveries.findOne.mockResolvedValue(
          chofer({ deliveryId: 'del-9', userId: 'user-9' }),
        );
        await servicio.vencerPropuestas(
          new Date(proposals.filas[0].expiresAt.getTime() + 1000),
        );
        expect(proposals.filas[1].deliveryId).toBe('del-9');
      });
    });

    describe('B5, B6, B8 y anticipación por km', () => {
      it('no se fija ventana a un trámite sin taller', async () => {
        const t = tarea({
          plan: plan({ documentKind: MaintenanceDocumentKind.INSURANCE }),
        });
        await expect(
          servicio.forzar(
            D1,
            t.taskId,
            { windowStart: dias(3), windowEnd: dias(3.2) },
            'a',
            AHORA,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('al dejar fuera de servicio libera el vehículo, como un siniestro', async () => {
        tarea({
          dueAt: dias(-5),
          plan: plan({
            name: 'VTV',
            criticality: MaintenanceCriticality.BLOCKING,
            documentKind: MaintenanceDocumentKind.VTV,
          }),
        });
        await servicio.ejecutar(D1, AHORA);
        expect(assignments.liberarDelVehiculo).toHaveBeenCalledWith(
          'car-1',
          expect.anything(),
          expect.objectContaining({
            motivo: expect.stringContaining('fuera de servicio') as string,
          }),
        );
      });

      it('un plan bloqueante por km que ya llegó a su kilometraje también deja fuera de servicio', async () => {
        carService.findAll.mockResolvedValue([auto({ odometerKm: 12_000 })]);
        tarea({
          dueAt: null,
          dueKm: 11_000,
          plan: plan({
            name: 'Frenos',
            criticality: MaintenanceCriticality.BLOCKING,
          }),
        });
        const r = await servicio.ejecutar(D1, AHORA);
        expect(r.vehiculosFueraDeServicio).toBe(1);
      });

      it('el correo al chofer sólo sale si la distribuidora lo activó', async () => {
        tarea({ dueAt: dias(6) });
        await servicio.ejecutar(D1, AHORA);
        expect(notifier.propuestaAlChofer).toHaveBeenLastCalledWith(
          expect.anything(),
          expect.anything(),
          expect.anything(),
          false,
        );
        cleanupCases();
        params.driverEmail = 1;
        await servicio.ejecutar(D1, AHORA);
        expect(notifier.propuestaAlChofer).toHaveBeenLastCalledWith(
          expect.anything(),
          expect.anything(),
          expect.anything(),
          true,
        );
      });

      it('la anticipación por km planifica una tarea cuya fecha está lejos pero a la que le faltan pocos km', async () => {
        conUso('car-1', 60, 10); // 10 km/día: 2.000 km son 200 días
        params.anticipationKm = 2500;
        tarea({ dueAt: null, dueKm: 12_000, plan: plan({ leadTimeDays: 15 }) });
        const r = await servicio.ejecutar(D1, AHORA);
        expect(r.propuestas + r.escaladas).toBe(1);
      });

      it('sin anticipación por km esa misma tarea no se planifica', async () => {
        conUso('car-1', 60, 10);
        params.anticipationKm = 0;
        tarea({ dueAt: null, dueKm: 12_000, plan: plan({ leadTimeDays: 15 }) });
        const r = await servicio.ejecutar(D1, AHORA);
        expect(r.propuestas + r.escaladas).toBe(0);
      });
    });

    describe('A1: el uso desactualizado no se proyecta', () => {
      it('un vehículo que dejó de registrar uso no proyecta por km (no es uno que anda poco)', async () => {
        usage.find.mockImplementation(() =>
          Promise.resolve(
            Array.from({ length: 40 }, (_, i) => ({
              carId: 'car-1',
              day: sumarDias('2026-10-30', -(30 + i)),
              km: 50,
            })) as unknown as VehicleUsageLog[],
          ),
        );
        const t = tarea({ dueAt: null, dueKm: 10_300 });
        const [v] = await servicio.vencimientos(D1, {}, AHORA);
        expect(v.consumo?.desactualizado).toBe(true);
        expect(v.items[0].proyeccion.porKilometraje).toBeNull();
        expect(v.items[0].proyeccion.enObservacion).toBe(true);
        expect(t.predictedDueAt).toBeNull();
      });

      it('antes de planificar se alimenta el registro de uso', async () => {
        tarea();
        await servicio.ejecutar(D1, AHORA);
        expect(feed.alimentar).toHaveBeenCalledWith(D1, AHORA);
      });

      it('si la alimentación falla, la corrida sigue', async () => {
        feed.alimentar.mockRejectedValue(new Error('sin PostGIS'));
        tarea({ dueAt: dias(6) });
        const r = await servicio.ejecutar(D1, AHORA);
        expect(r.propuestas).toBe(1);
      });
    });

    describe('M7 y B2', () => {
      it('el chofer consulta el horario, los días y los feriados del taller', async () => {
        params.workshopDays = 126;
        const a = await servicio.ajustesParaElChofer('user-1', AHORA);
        expect(a).toMatchObject({
          workshopStartHour: 8,
          workshopEndHour: 13,
          workshopDays: [1, 2, 3, 4, 5, 6],
          minLeadDays: 1,
          horizonDays: 30,
        });
        expect(a.holidays).toContain('2026-11-23');
        expect(a.holidays).not.toContain('2026-10-12');
      });

      it('la próxima ventana de una tarea confirmada trae su fin real, no duración cero', async () => {
        tarea({ dueAt: dias(6) });
        await servicio.ejecutar(D1, AHORA);
        await servicio.aceptar('user-1', proposals.filas[0].proposalId, AHORA);
        await servicio.confirmar(
          D1,
          cases.filas[0].caseId,
          {},
          'admin-1',
          AHORA,
        );
        const [v] = await servicio.vencimientos(D1, {}, AHORA);
        expect(v.proximaVentana?.end.getTime()).toBeGreaterThan(
          v.proximaVentana!.start.getTime(),
        );
      });

      it('al escalarse un caso se avisa también al chofer', async () => {
        tarea({ dueAt: dias(6) });
        params.topNWindows = 1;
        await servicio.ejecutar(D1, AHORA);
        await servicio.rechazar(
          'user-1',
          proposals.filas[0].proposalId,
          { reason: 'No puedo' },
          AHORA,
        );
        expect(notifier.escaladoAlChofer).toHaveBeenCalledWith(
          expect.objectContaining({ userId: 'user-1' }),
          cases.filas[0],
          expect.anything(),
        );
      });
    });
  });

  const cleanupCases = () => {
    cases.filas.splice(0, cases.filas.length);
    proposals.filas.splice(0, proposals.filas.length);
  };
});
