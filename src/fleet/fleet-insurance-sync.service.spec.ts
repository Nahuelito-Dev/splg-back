import { EntityManager } from 'typeorm';
import { FleetInsuranceSyncService } from './fleet-insurance-sync.service';
import {
  MaintenancePlan,
  MaintenanceSubject,
} from './entities/maintenance-plan.entity';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from './entities/maintenance-task.entity';

const HOY = '2026-10-28';

describe('FleetInsuranceSyncService', () => {
  const service = new FleetInsuranceSyncService();
  let planes: Array<Partial<MaintenancePlan>>;
  let abiertas: Array<Partial<MaintenanceTask>>;
  let guardadas: Array<Partial<MaintenanceTask>>;
  let manager: EntityManager;
  let dondePlanes: unknown;

  const poliza = {
    distributorId: 'd1',
    carId: 'c1',
    typeCar: 'Camioneta',
    validFrom: '2026-12-22',
    validTo: '2027-06-22',
    cost: 179748,
    insurerName: 'Seguros Rivadavia',
    policyNumber: '67/02/192143',
  };

  beforeEach(() => {
    planes = [{ planId: 'plan-general', carType: null }];
    abiertas = [];
    guardadas = [];
    dondePlanes = undefined;
    const repoPlanes = {
      find: jest.fn((op: { where: unknown }) => {
        dondePlanes = op.where;
        return Promise.resolve(planes);
      }),
    };
    const repoTareas = { find: jest.fn(() => Promise.resolve(abiertas)) };
    manager = {
      getRepository: jest.fn((e: unknown) =>
        e === MaintenancePlan ? repoPlanes : repoTareas,
      ),
      create: jest.fn((_e: unknown, datos: object) => datos),
      save: jest.fn((x: Partial<MaintenanceTask>) => {
        guardadas.push({ ...x });
        return Promise.resolve({ taskId: 'nueva', ...x });
      }),
    } as unknown as EntityManager;
  });

  it('crea la tarea de seguro con el vencimiento, la vigencia, la prima y la póliza', async () => {
    const r = await service.sincronizar(manager, poliza, HOY);

    expect(r).toEqual({
      synced: true,
      pending: false,
      taskId: 'nueva',
      closedTasks: [],
      reason: null,
    });
    expect(dondePlanes).toMatchObject({
      distributorId: 'd1',
      subject: MaintenanceSubject.VEHICLE,
      documentKind: 'insurance',
      isActive: true,
    });
    expect(guardadas[0]).toMatchObject({
      planId: 'plan-general',
      distributorId: 'd1',
      carId: 'c1',
      status: MaintenanceTaskStatus.SCHEDULED,
      dueAt: new Date('2027-06-22T00:00:00.000Z'),
      validFrom: new Date('2026-12-22T00:00:00.000Z'),
      cost: 179748,
      provider: 'Seguros Rivadavia',
      referenceNumber: '67/02/192143',
    });
  });

  it('cierra como hecha la tarea anterior y deja la nueva', async () => {
    const anterior = {
      taskId: 'vieja',
      status: MaintenanceTaskStatus.SCHEDULED,
      dueAt: new Date('2026-12-22T00:00:00.000Z'),
      performedAt: null,
    } as Partial<MaintenanceTask>;
    abiertas = [anterior];

    const r = await service.sincronizar(manager, poliza, HOY);

    expect(r.synced).toBe(true);
    expect(guardadas[0]).toMatchObject({
      taskId: 'vieja',
      status: MaintenanceTaskStatus.DONE,
    });
    expect(guardadas[0].performedAt).toBeInstanceOf(Date);
    expect(guardadas[1]).toMatchObject({
      status: MaintenanceTaskStatus.SCHEDULED,
      dueAt: new Date('2027-06-22T00:00:00.000Z'),
    });
  });

  it('sin plan de seguro activo no inventa nada y lo dice', async () => {
    planes = [];
    const r = await service.sincronizar(manager, poliza, HOY);
    expect(r.synced).toBe(false);
    expect(r.reason).toMatch(/plan de seguro/);
    expect(guardadas).toHaveLength(0);
  });

  it('una póliza que no vence después de lo ya cargado (historial) no toca la flota', async () => {
    abiertas = [
      {
        taskId: 'vigente',
        status: MaintenanceTaskStatus.SCHEDULED,
        dueAt: new Date('2027-06-22T00:00:00.000Z'),
      },
    ];
    const r = await service.sincronizar(manager, poliza, HOY);
    expect(r).toMatchObject({ synced: false, taskId: 'vigente' });
    expect(guardadas).toHaveLength(0);
  });

  it('prefiere el plan del tipo de vehículo al general', async () => {
    planes = [
      { planId: 'plan-general', carType: null },
      { planId: 'plan-camioneta', carType: 'camioneta' },
    ];
    await service.sincronizar(manager, poliza, HOY);
    expect(guardadas[0].planId).toBe('plan-camioneta');
  });

  it('un plan de otro tipo de vehículo no aplica', async () => {
    planes = [{ planId: 'plan-moto', carType: 'Moto' }];
    const r = await service.sincronizar(manager, poliza, HOY);
    expect(r.synced).toBe(false);
  });

  describe('hueco entre la vigente y la póliza nueva', () => {
    const vigente = (dueAt: string) =>
      ({
        taskId: 'vigente',
        status: MaintenanceTaskStatus.SCHEDULED,
        dueAt: new Date(dueAt),
      }) as Partial<MaintenanceTask>;

    it('si empieza después de que vence la tarea actual, NO la cierra y queda pendiente', async () => {
      abiertas = [vigente('2026-12-01T00:00:00.000Z')];
      const r = await service.sincronizar(manager, poliza, HOY);

      expect(r).toMatchObject({ synced: false, pending: true, taskId: null });
      expect(r.reason).toMatch(/cuando empiece/);
      expect(guardadas).toHaveLength(0);
    });

    it('si empieza justo cuando vence la tarea actual no hay hueco: la reemplaza', async () => {
      abiertas = [vigente('2026-12-22T00:00:00.000Z')];
      const r = await service.sincronizar(manager, poliza, HOY);
      expect(r).toMatchObject({
        synced: true,
        pending: false,
        closedTasks: [
          { taskId: 'vigente', status: MaintenanceTaskStatus.SCHEDULED },
        ],
      });
      expect(guardadas[0].status).toBe(MaintenanceTaskStatus.DONE);
    });

    it('si hay hueco pero la póliza ya empezó, se sincroniza (cierra la vencida)', async () => {
      abiertas = [vigente('2026-10-01T00:00:00.000Z')];
      const r = await service.sincronizar(
        manager,
        { ...poliza, validFrom: '2026-10-20' },
        HOY,
      );
      expect(r.synced).toBe(true);
      expect(guardadas[0].status).toBe(MaintenanceTaskStatus.DONE);
    });

    it('sin tarea abierta se crea igual aunque la póliza empiece más adelante', async () => {
      const r = await service.sincronizar(manager, poliza, HOY);
      expect(r.synced).toBe(true);
    });
  });

  it('una póliza que ya venció es historial: no toca la flota', async () => {
    const r = await service.sincronizar(
      manager,
      { ...poliza, validFrom: '2025-01-01', validTo: HOY },
      HOY,
    );
    expect(r).toMatchObject({ synced: false, pending: false });
    expect(r.reason).toMatch(/venció/);
    expect(guardadas).toHaveLength(0);
  });

  describe('revertir', () => {
    const tareas = {
      distributorId: 'd1',
      taskId: 'creada',
      closedTasks: [
        { taskId: 'previa', status: MaintenanceTaskStatus.IN_PROGRESS },
      ],
      validTo: '2027-06-22',
    };
    let porId: Record<string, Partial<MaintenanceTask>>;

    beforeEach(() => {
      porId = {
        creada: {
          taskId: 'creada',
          status: MaintenanceTaskStatus.SCHEDULED,
          dueAt: new Date('2027-06-22T00:00:00.000Z'),
          notes: null,
        },
        previa: {
          taskId: 'previa',
          status: MaintenanceTaskStatus.DONE,
          performedAt: new Date(),
          dueAt: new Date('2026-12-22T00:00:00.000Z'),
        },
      };
      (manager.getRepository as jest.Mock).mockImplementation(() => ({
        findOne: jest.fn(({ where }: { where: { taskId: string } }) =>
          Promise.resolve(porId[where.taskId] ?? null),
        ),
      }));
    });

    it('cancela la tarea creada y reabre la anterior con su estado y su vencimiento', async () => {
      const r = await service.revertir(manager, tareas);

      expect(r).toEqual({ reverted: true, notes: [] });
      expect(porId.creada.status).toBe(MaintenanceTaskStatus.CANCELLED);
      expect(porId.previa.status).toBe(MaintenanceTaskStatus.IN_PROGRESS);
      expect(porId.previa.performedAt).toBeNull();
      expect(porId.previa.dueAt).toEqual(new Date('2026-12-22T00:00:00.000Z'));
    });

    it.each([
      ['se cerró', { status: MaintenanceTaskStatus.DONE }],
      ['se reprogramó', { dueAt: new Date('2027-07-01T00:00:00.000Z') }],
      ['se le anotó algo', { notes: 'renovada a mano' }],
    ])(
      'si la tarea creada %s no se pisa, no se reabre la anterior y se informa',
      async (_caso, cambio) => {
        Object.assign(porId.creada, cambio);
        const r = await service.revertir(manager, tareas);

        expect(r.reverted).toBe(false);
        expect(r.notes[0]).toMatch(/ya cambió/);
        expect(porId.previa.status).toBe(MaintenanceTaskStatus.DONE);
        expect(guardadas).toHaveLength(0);
      },
    );

    it('si la anterior ya cambió no se reabre y se informa, pero la creada sí se cancela', async () => {
      porId.previa.status = MaintenanceTaskStatus.CANCELLED;
      const r = await service.revertir(manager, tareas);
      expect(r.reverted).toBe(true);
      expect(r.notes[0]).toMatch(/previa/);
      expect(porId.creada.status).toBe(MaintenanceTaskStatus.CANCELLED);
      expect(porId.previa.status).toBe(MaintenanceTaskStatus.CANCELLED);
    });

    it('una póliza que no creó nada en la flota no revierte nada', async () => {
      const r = await service.revertir(manager, {
        ...tareas,
        taskId: null,
        closedTasks: [],
      });
      expect(r).toEqual({ reverted: true, notes: [] });
      expect(guardadas).toHaveLength(0);
    });
  });
});
