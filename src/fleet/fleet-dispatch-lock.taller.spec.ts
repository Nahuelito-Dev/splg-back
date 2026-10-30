import { Repository } from 'typeorm';
import { VehicleAssignmentService } from '../car/vehicle-assignment.service';
import { DeliveryService } from '../delivery/delivery.service';
import { EmployeeService } from '../employee/employee.service';
import { LeaveService } from '../leave/leave.service';
import { MaintenancePlanningCase } from './entities/maintenance-planning-case.entity';
import { MaintenanceTask } from './entities/maintenance-task.entity';
import { FleetDispatchLockService } from './fleet-dispatch-lock.service';

/** La agenda del taller (CU-105, paso 8): una ventana confirmada que está corriendo bloquea al chofer. */
describe('FleetDispatchLockService: taller programado', () => {
  let getRawMany: jest.Mock;
  let where: jest.Mock;
  let service: FleetDispatchLockService;

  const armar = (conCasos: boolean) => {
    getRawMany = jest.fn().mockResolvedValue([]);
    where = jest.fn();
    const qb = {
      innerJoin: () => qb,
      select: () => qb,
      where: (...a: unknown[]) => {
        where(...a);
        return qb;
      },
      andWhere: (...a: unknown[]) => {
        where(...a);
        return qb;
      },
      getRawMany,
    };
    return new FleetDispatchLockService(
      {
        find: jest.fn().mockResolvedValue([]),
      } as unknown as Repository<MaintenanceTask>,
      {
        findVehiculosEnUsoPorDeliveryIds: jest.fn().mockResolvedValue([
          {
            deliveryId: 'dl1',
            carId: 'c1',
            patent: 'AB123CD',
            brand: null,
            model: null,
            fleetStatus: 'active',
          },
          {
            deliveryId: 'dl2',
            carId: 'c2',
            patent: 'CD456EF',
            brand: null,
            model: null,
            fleetStatus: 'active',
          },
        ]),
      } as unknown as VehicleAssignmentService,
      {
        findDeliveryIdsByUserIds: jest.fn().mockResolvedValue([
          { deliveryId: 'dl1', userId: 'u1' },
          { deliveryId: 'dl2', userId: 'u2' },
        ]),
      } as unknown as DeliveryService,
      {
        findByUserIds: jest.fn().mockResolvedValue([]),
      } as unknown as EmployeeService,
      {
        empleadosDeLicenciaEn: jest.fn().mockResolvedValue(new Set()),
      } as unknown as LeaveService,
      conCasos
        ? ({
            createQueryBuilder: () => qb,
          } as unknown as Repository<MaintenancePlanningCase>)
        : undefined,
    );
  };

  beforeEach(() => {
    service = armar(true);
  });

  it('el chofer cuyo vehículo está en su ventana de taller confirmada no recibe pedidos', async () => {
    getRawMany.mockResolvedValue([{ carId: 'c1' }]);
    const inhabilitados = await service.choferesInhabilitados(
      ['u1', 'u2'],
      'd1',
    );
    expect([...inhabilitados]).toEqual(['u1']);
  });

  it('dice el motivo en castellano', async () => {
    getRawMany.mockResolvedValue([{ carId: 'c1' }]);
    expect(await service.motivosDeInhabilitacion('u1', 'd1')).toEqual([
      'su vehículo tiene el taller programado en este horario',
    ]);
  });

  it('sólo cuenta ventanas confirmadas, en curso y de tareas todavía abiertas', async () => {
    await service.choferesInhabilitados(['u1'], 'd1');
    const condiciones = (where.mock.calls as string[][])
      .map((c) => String(c[0]))
      .join(' | ');
    expect(condiciones).toContain('c.status = :confirmado');
    expect(condiciones).toContain(
      'c.chosen_start <= :ahora AND c.chosen_end > :ahora',
    );
    expect(condiciones).toContain('t.status NOT IN (:...cerrados)'); // al cerrar la tarea se libera
  });

  it('fuera de la ventana nadie queda bloqueado', async () => {
    expect((await service.choferesInhabilitados(['u1', 'u2'], 'd1')).size).toBe(
      0,
    );
  });

  it('sin el repositorio de casos (módulo sin planificador) no cambia nada', async () => {
    service = armar(false);
    expect((await service.choferesInhabilitados(['u1', 'u2'], 'd1')).size).toBe(
      0,
    );
  });
});
