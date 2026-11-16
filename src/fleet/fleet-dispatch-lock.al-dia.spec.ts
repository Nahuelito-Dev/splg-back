import { Repository } from 'typeorm';
import { VehicleAssignmentService } from '../car/vehicle-assignment.service';
import { DeliveryService } from '../delivery/delivery.service';
import { EmployeeService } from '../employee/employee.service';
import { EmployeeStatus } from '../employee/entities/employee.entity';
import { LeaveService } from '../leave/leave.service';
import {
  MaintenanceCriticality,
  MaintenancePlan,
} from './entities/maintenance-plan.entity';
import { MaintenancePlanningCase } from './entities/maintenance-planning-case.entity';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from './entities/maintenance-task.entity';
import {
  FleetDispatchLockService,
  MOTIVO_LICENCIA_EL_DIA,
  MOTIVO_VEHICULO_TALLER_EL_DIA,
} from './fleet-dispatch-lock.service';

const plan = (name: string, criticality = MaintenanceCriticality.BLOCKING) =>
  ({ name, leadTimeDays: 10, criticality }) as unknown as MaintenancePlan;

const tarea = (over: Partial<MaintenanceTask>) =>
  ({
    status: MaintenanceTaskStatus.SCHEDULED,
    carId: null,
    deliveryId: null,
    employeeId: null,
    distributorId: 'd1',
    ...over,
  }) as unknown as MaintenanceTask;

/**
 * Habilitación a la FECHA del plan (la hoja de ruta de ese día): licencias que
 * cubren ese día, vencimientos a ese día y la agenda del taller de ese día. No
 * exige vehículo en uso (la hoja trae el suyo) y no cambia lo del despacho.
 */
describe('FleetDispatchLockService.habilitacionAlDia', () => {
  let taller: jest.Mock;
  let rango: unknown[];

  function armar(o: {
    tareas?: MaintenanceTask[];
    legajos?: Array<{
      employeeId: string;
      userId: string;
      status: EmployeeStatus;
    }>;
    deLicencia?: string[];
    enTaller?: string[];
    conAgenda?: boolean;
  }) {
    rango = [];
    taller = jest
      .fn()
      .mockResolvedValue((o.enTaller ?? []).map((carId) => ({ carId })));
    const qb = {
      innerJoin: () => qb,
      select: () => qb,
      where: () => qb,
      andWhere: (...a: unknown[]) => {
        rango.push(a);
        return qb;
      },
      getRawMany: taller,
    };
    const leaves = {
      empleadosDeLicenciaEn: jest
        .fn()
        .mockResolvedValue(new Set(o.deLicencia ?? [])),
    };
    const vehicleAssignments = { findVehiculosEnUsoPorDeliveryIds: jest.fn() };
    const svc = new FleetDispatchLockService(
      {
        find: jest.fn().mockResolvedValue(o.tareas ?? []),
      } as unknown as Repository<MaintenanceTask>,
      vehicleAssignments as unknown as VehicleAssignmentService,
      {
        findDeliveryIdsByUserIds: jest.fn().mockResolvedValue([
          { deliveryId: 'dl1', userId: 'u1' },
          { deliveryId: 'dl2', userId: 'u2' },
        ]),
      } as unknown as DeliveryService,
      {
        findByUserIds: jest.fn().mockResolvedValue(o.legajos ?? []),
      } as unknown as EmployeeService,
      leaves as unknown as LeaveService,
      o.conAgenda === false
        ? undefined
        : ({
            createQueryBuilder: () => qb,
          } as unknown as Repository<MaintenancePlanningCase>),
    );
    return { svc, leaves, vehicleAssignments };
  }

  it('licencia del día y legajo egresado: no puede ese día; no mira el vehículo en uso', async () => {
    const { svc, leaves, vehicleAssignments } = armar({
      legajos: [
        { employeeId: 'e1', userId: 'u1', status: EmployeeStatus.ACTIVE },
        {
          employeeId: 'e2',
          userId: 'u2',
          status: EmployeeStatus.TERMINATED,
        },
      ],
      deLicencia: ['e1'],
    });
    const r = await svc.habilitacionAlDia(['u1', 'u2'], [], 'd1', '2099-03-10');
    expect(leaves.empleadosDeLicenciaEn).toHaveBeenCalledWith(
      ['e1', 'e2'],
      '2099-03-10',
    );
    expect(r.choferes.get('u1')).toEqual([MOTIVO_LICENCIA_EL_DIA]);
    expect(r.choferes.get('u2')).toEqual(['su legajo está egresado']);
    expect(
      vehicleAssignments.findVehiculosEnUsoPorDeliveryIds,
    ).not.toHaveBeenCalled();
  });

  it('un vencimiento cuenta a ESE día: vence antes del plan, inhabilita; vence después, no', async () => {
    const { svc } = armar({
      tareas: [
        tarea({
          deliveryId: 'dl1',
          dueAt: new Date('2099-03-05T00:00:00Z'),
          plan: plan('Licencia'),
        }),
        tarea({
          deliveryId: 'dl2',
          dueAt: new Date('2099-03-20T00:00:00Z'),
          plan: plan('Licencia'),
        }),
        tarea({
          carId: 'c1',
          dueAt: new Date('2099-03-09T00:00:00Z'),
          plan: plan('VTV'),
        }),
        tarea({
          carId: 'c2',
          dueAt: new Date('2099-03-10T00:00:00Z'),
          plan: plan('Seguro'),
        }),
        // Un service (no bloqueante) vencido nunca inhabilita.
        tarea({
          carId: 'c2',
          dueAt: new Date('2000-01-01T00:00:00Z'),
          plan: plan('Service', MaintenanceCriticality.NON_BLOCKING),
        }),
      ],
    });
    const r = await svc.habilitacionAlDia(
      ['u1', 'u2'],
      ['c1', 'c2'],
      'd1',
      '2099-03-10',
    );
    expect(r.choferes.has('u1')).toBe(true);
    expect(r.choferes.has('u2')).toBe(false);
    expect(r.vehiculos.has('c1')).toBe(true);
    // Vence el mismo día del plan: vale todo ese día.
    expect(r.vehiculos.has('c2')).toBe(false);
  });

  it('la ventana de taller que se cruza con el día deja el vehículo afuera; sin agenda no consulta', async () => {
    const { svc } = armar({ enTaller: ['c1'] });
    const r = await svc.habilitacionAlDia([], ['c1', 'c2'], 'd1', '2099-03-10');
    expect(r.vehiculos.get('c1')).toEqual([MOTIVO_VEHICULO_TALLER_EL_DIA]);
    expect(r.vehiculos.has('c2')).toBe(false);
    const [, desdeHasta] = rango.find((a) =>
      String((a as unknown[])[0]).includes('chosen_start'),
    ) as [string, { desde: Date; hasta: Date }];
    expect(desdeHasta.desde.toISOString()).toBe('2099-03-10T03:00:00.000Z');
    expect(desdeHasta.hasta.getTime()).toBeGreaterThan(
      desdeHasta.desde.getTime(),
    );
    const sinAgenda = armar({ conAgenda: false });
    const r2 = await sinAgenda.svc.habilitacionAlDia(
      [],
      ['c1'],
      'd1',
      '2099-03-10',
    );
    expect(r2.vehiculos.size).toBe(0);
    expect(taller).not.toHaveBeenCalled();
  });

  it('una fecha inválida o sin nadie que mirar: vacío', async () => {
    const { svc } = armar({});
    expect(await svc.habilitacionAlDia(['u1'], ['c1'], 'd1', 'mañana')).toEqual(
      {
        choferes: new Map(),
        vehiculos: new Map(),
      },
    );
    const r = await svc.habilitacionAlDia([], [], 'd1', '2099-03-10');
    expect(r.choferes.size + r.vehiculos.size).toBe(0);
  });
});
