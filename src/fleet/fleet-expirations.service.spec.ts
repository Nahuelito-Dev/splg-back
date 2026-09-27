import { Repository } from 'typeorm';
import { FleetExpirationsService } from './fleet-expirations.service';
import { MaintenanceTask } from './entities/maintenance-task.entity';
import {
  MaintenanceCriticality,
  MaintenanceSubject,
} from './entities/maintenance-plan.entity';

describe('FleetExpirationsService', () => {
  let service: FleetExpirationsService;
  let getMany: jest.Mock;

  const plan = (
    over: Partial<{
      criticality: MaintenanceCriticality;
      subject: MaintenanceSubject;
    }> = {},
  ) => ({
    planId: 'p1',
    name: 'VTV',
    leadTimeDays: 30,
    criticality: MaintenanceCriticality.BLOCKING,
    subject: MaintenanceSubject.VEHICLE,
    ...over,
  });

  beforeEach(() => {
    getMany = jest.fn();
    const qb = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany,
    };
    const tasks = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    service = new FleetExpirationsService(
      tasks as unknown as Repository<MaintenanceTask>,
    );
  });

  it('agrupa por vehículo y marca inhabilitado si hay una bloqueante vencida', async () => {
    getMany.mockResolvedValue([
      {
        taskId: 't1',
        planId: 'p1',
        plan: plan(),
        dueAt: new Date('2020-01-01'),
        car: {
          carId: 'c1',
          carPatent: 'AB123CD',
          carBrand: 'Ford',
          carModel: 'Ranger',
        },
      } as unknown as MaintenanceTask,
    ]);

    const res = await service.find('d1', 30);

    expect(res.vehicles).toHaveLength(1);
    expect(res.vehicles[0]).toMatchObject({ carId: 'c1', isLocked: true });
    expect(res.vehicles[0].items).toHaveLength(1);
    expect(res.drivers).toHaveLength(0);
  });

  it('agrupa por chofer', async () => {
    getMany.mockResolvedValue([
      {
        taskId: 't2',
        planId: 'p2',
        plan: plan({ subject: MaintenanceSubject.DRIVER }),
        dueAt: new Date('2027-01-01'),
        delivery: {
          deliveryId: 'dl1',
          userId: 'u1',
          user: { fullName: 'Juan Pérez' },
        },
      } as unknown as MaintenanceTask,
    ]);

    const res = await service.find('d1', 30);

    expect(res.drivers).toHaveLength(1);
    expect(res.drivers[0]).toMatchObject({
      deliveryId: 'dl1',
      fullName: 'Juan Pérez',
    });
  });

  it('una no bloqueante vencida no inhabilita al vehículo', async () => {
    getMany.mockResolvedValue([
      {
        taskId: 't3',
        planId: 'p3',
        plan: plan({ criticality: MaintenanceCriticality.NON_BLOCKING }),
        dueAt: new Date('2020-01-01'),
        car: { carId: 'c1', carPatent: null, carBrand: null, carModel: null },
      } as unknown as MaintenanceTask,
    ]);

    const res = await service.find('d1', 30);
    expect(res.vehicles[0].isLocked).toBe(false);
  });

  it('un vehículo con dos tareas: una vencida y otra vigente, se agrupan en la misma entrada', async () => {
    const auto = {
      carId: 'c1',
      carPatent: 'AB123CD',
      carBrand: null,
      carModel: null,
    };
    getMany.mockResolvedValue([
      {
        taskId: 't1',
        planId: 'p1',
        plan: plan(),
        dueAt: new Date('2020-01-01'),
        car: auto,
      },
      {
        taskId: 't2',
        planId: 'p4',
        plan: plan({ criticality: MaintenanceCriticality.NON_BLOCKING }),
        dueAt: new Date('2026-10-01'),
        car: auto,
      },
    ] as unknown as MaintenanceTask[]);

    const res = await service.find('d1', 30);
    expect(res.vehicles).toHaveLength(1);
    expect(res.vehicles[0].items).toHaveLength(2);
  });

  it('devuelve el withinDays pedido', async () => {
    getMany.mockResolvedValue([]);
    const res = await service.find('d1', 45);
    expect(res.withinDays).toBe(45);
  });
});
