import { Repository } from 'typeorm';
import { FleetExpirationsService } from './fleet-expirations.service';
import { MaintenanceTask } from './entities/maintenance-task.entity';
import {
  MaintenanceCriticality,
  MaintenanceSubject,
} from './entities/maintenance-plan.entity';
import {
  FleetExpirationsQueryDto,
  FleetExpirationsSubject,
} from './dto/expirations-query.dto';
import { EmployeeService } from '../employee/employee.service';
import { JobPositionCategory } from '../employee/entities/job-position.entity';

describe('FleetExpirationsService', () => {
  let service: FleetExpirationsService;
  let getMany: jest.Mock;
  let findByUserIds: jest.Mock;

  const consulta = (
    over: Partial<FleetExpirationsQueryDto> = {},
  ): FleetExpirationsQueryDto =>
    ({ withinDays: 30, ...over }) as FleetExpirationsQueryDto;

  const legajo = (over: Record<string, unknown> = {}) => ({
    employeeId: 'e1',
    userId: 'u1',
    firstName: 'Ana',
    lastName: 'Pérez',
    fileNumber: '0001',
    position: { name: 'Chofer', category: JobPositionCategory.DRIVER },
    ...over,
  });

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
    findByUserIds = jest.fn().mockResolvedValue([]);
    service = new FleetExpirationsService(
      tasks as unknown as Repository<MaintenanceTask>,
      { findByUserIds } as unknown as EmployeeService,
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

    const res = await service.find('d1', consulta());

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

    const res = await service.find('d1', consulta());

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

    const res = await service.find('d1', consulta());
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

    const res = await service.find('d1', consulta());
    expect(res.vehicles).toHaveLength(1);
    expect(res.vehicles[0].items).toHaveLength(2);
  });

  it('devuelve el withinDays pedido', async () => {
    getMany.mockResolvedValue([]);
    const res = await service.find('d1', consulta({ withinDays: 45 }));
    expect(res.withinDays).toBe(45);
  });

  describe('personal (CU-187)', () => {
    const tareaDeEmpleado = (
      over: Record<string, unknown> = {},
      empleado = legajo(),
    ) =>
      ({
        taskId: 't-e',
        planId: 'p-e',
        plan: plan({ subject: MaintenanceSubject.EMPLOYEE }),
        dueAt: new Date('2020-01-01'),
        employee: empleado,
        ...over,
      }) as unknown as MaintenanceTask;

    it('agrupa por empleado con su puesto y lo marca inhabilitado si una bloqueante venció', async () => {
      getMany.mockResolvedValue([tareaDeEmpleado()]);

      const res = await service.find('d1', consulta());

      expect(res.employees).toHaveLength(1);
      expect(res.employees[0]).toMatchObject({
        employeeId: 'e1',
        fullName: 'Ana Pérez',
        fileNumber: '0001',
        positionName: 'Chofer',
        category: JobPositionCategory.DRIVER,
        isLocked: true,
      });
      expect(res.vehicles).toEqual([]);
    });

    it('una no bloqueante vencida (la ART) no lo inhabilita', async () => {
      getMany.mockResolvedValue([
        tareaDeEmpleado({
          plan: plan({
            subject: MaintenanceSubject.EMPLOYEE,
            criticality: MaintenanceCriticality.NON_BLOCKING,
          }),
        }),
      ]);

      const res = await service.find('d1', consulta());

      expect(res.employees[0].isLocked).toBe(false);
    });

    it('lleva la licencia de conducir de un chofer a su legajo, sin sacarla del grupo de choferes', async () => {
      findByUserIds.mockResolvedValue([legajo()]);
      getMany.mockResolvedValue([
        {
          taskId: 't-l',
          planId: 'p-l',
          plan: plan({ subject: MaintenanceSubject.DRIVER }),
          dueAt: new Date('2020-01-01'),
          delivery: {
            deliveryId: 'dl1',
            userId: 'u1',
            user: { fullName: 'x' },
          },
        } as unknown as MaintenanceTask,
        tareaDeEmpleado({ dueAt: new Date('2019-01-01') }),
      ]);

      const res = await service.find('d1', consulta());

      expect(res.drivers).toHaveLength(1);
      expect(res.employees).toHaveLength(1);
      expect(res.employees[0].items.map((i) => i.taskId)).toEqual([
        't-e',
        't-l',
      ]);
    });

    it('la categoría filtra al personal', async () => {
      getMany.mockResolvedValue([
        tareaDeEmpleado(),
        tareaDeEmpleado(
          { taskId: 't-v' },
          legajo({
            employeeId: 'e2',
            position: {
              name: 'Depósito',
              category: JobPositionCategory.WAREHOUSE,
            },
          }),
        ),
      ]);

      const res = await service.find(
        'd1',
        consulta({ category: JobPositionCategory.WAREHOUSE }),
      );

      expect(res.employees.map((e) => e.employeeId)).toEqual(['e2']);
    });

    it('subject=vehicle no trae personal; subject=employee no trae vehículos ni choferes', async () => {
      const auto = {
        carId: 'c1',
        carPatent: null,
        carBrand: null,
        carModel: null,
      };
      getMany.mockResolvedValue([
        tareaDeEmpleado(),
        {
          taskId: 't-c',
          planId: 'p1',
          plan: plan(),
          dueAt: new Date('2020-01-01'),
          car: auto,
        } as unknown as MaintenanceTask,
      ]);

      const soloVehiculos = await service.find(
        'd1',
        consulta({ subject: FleetExpirationsSubject.VEHICLE }),
      );
      const soloPersonal = await service.find(
        'd1',
        consulta({ subject: FleetExpirationsSubject.EMPLOYEE }),
      );

      expect(soloVehiculos.employees).toEqual([]);
      expect(soloVehiculos.vehicles).toHaveLength(1);
      expect(soloPersonal.vehicles).toEqual([]);
      expect(soloPersonal.drivers).toEqual([]);
      expect(soloPersonal.employees).toHaveLength(1);
    });

    it('ordena a los empleados por su vencimiento más próximo', async () => {
      getMany.mockResolvedValue([
        tareaDeEmpleado(
          { taskId: 't-b', dueAt: new Date('2022-01-01') },
          legajo({ employeeId: 'e2', firstName: 'Beto' }),
        ),
        tareaDeEmpleado({ taskId: 't-a', dueAt: new Date('2020-01-01') }),
      ]);

      const res = await service.find('d1', consulta());

      expect(res.employees.map((e) => e.employeeId)).toEqual(['e1', 'e2']);
    });
  });
});
