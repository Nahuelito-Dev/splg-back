import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { FleetTaskService } from './fleet-task.service';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from './entities/maintenance-task.entity';
import {
  MaintenanceCriticality,
  MaintenancePlan,
  MaintenanceSubject,
  MaintenanceTrigger,
} from './entities/maintenance-plan.entity';
import { CarService } from '../car/car.service';
import { DeliveryService } from '../delivery/delivery.service';

describe('FleetTaskService', () => {
  let service: FleetTaskService;
  let tasks: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let plans: { findOne: jest.Mock };
  let carService: { findOne: jest.Mock };
  let deliveryService: { findOne: jest.Mock };

  const planVehiculo = {
    planId: 'plan-vtv',
    distributorId: 'd1',
    name: 'VTV',
    subject: MaintenanceSubject.VEHICLE,
    trigger: MaintenanceTrigger.BY_FIXED_DATE,
    intervalKm: null,
    intervalMonths: null,
    leadTimeDays: 30,
    criticality: MaintenanceCriticality.BLOCKING,
    carType: null,
    isActive: true,
  } as unknown as MaintenancePlan;

  const planChofer: MaintenancePlan = {
    ...planVehiculo,
    planId: 'plan-licencia',
    subject: MaintenanceSubject.DRIVER,
  };

  beforeEach(() => {
    tasks = {
      create: jest.fn((t: Partial<MaintenanceTask>) => t),
      save: jest.fn((t: MaintenanceTask) => Promise.resolve(t)),
      findOne: jest.fn(),
      find: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    plans = { findOne: jest.fn() };
    carService = { findOne: jest.fn() };
    deliveryService = { findOne: jest.fn() };

    service = new FleetTaskService(
      tasks as unknown as Repository<MaintenanceTask>,
      plans as unknown as Repository<MaintenancePlan>,
      carService as unknown as CarService,
      deliveryService as unknown as DeliveryService,
    );
  });

  describe('create', () => {
    it('un plan de vehículo necesita carId y el auto de esta distribuidora', async () => {
      plans.findOne.mockResolvedValue(planVehiculo);
      carService.findOne.mockResolvedValue({
        carId: 'c1',
        distributorId: 'd1',
      });

      const task = await service.create(
        { planId: 'plan-vtv', carId: 'c1', dueAt: '2026-12-01T00:00:00.000Z' },
        'd1',
      );

      expect(carService.findOne).toHaveBeenCalledWith('c1', 'd1');
      expect(task).toMatchObject({ carId: 'c1', distributorId: 'd1' });
    });

    it('un plan de vehículo sin carId es 400', async () => {
      plans.findOne.mockResolvedValue(planVehiculo);
      await expect(
        service.create({ planId: 'plan-vtv' }, 'd1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('un plan de vehículo con deliveryId (en vez de carId) es 400', async () => {
      plans.findOne.mockResolvedValue(planVehiculo);
      await expect(
        service.create({ planId: 'plan-vtv', deliveryId: 'dl1' }, 'd1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('un plan de chofer necesita deliveryId de esta distribuidora', async () => {
      plans.findOne.mockResolvedValue(planChofer);
      deliveryService.findOne.mockResolvedValue({
        deliveryId: 'dl1',
        distributorId: 'd1',
      });

      const task = await service.create(
        { planId: 'plan-licencia', deliveryId: 'dl1' },
        'd1',
      );
      expect(task).toMatchObject({ deliveryId: 'dl1' });
    });

    it('un chofer de otra distribuidora es 404 (no se revela que existe)', async () => {
      plans.findOne.mockResolvedValue(planChofer);
      deliveryService.findOne.mockResolvedValue({
        deliveryId: 'dl1',
        distributorId: 'd2',
      });
      await expect(
        service.create({ planId: 'plan-licencia', deliveryId: 'dl1' }, 'd1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('un plan de otra distribuidora es 404', async () => {
      plans.findOne.mockResolvedValue(null);
      await expect(
        service.create({ planId: 'plan-vtv', carId: 'c1' }, 'd1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('findAll', () => {
    function mockQb(resultado: MaintenanceTask[]) {
      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        offset: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(resultado),
      };
      tasks.createQueryBuilder.mockReturnValue(qb);
      return qb;
    }

    it('lista con paginación por defecto, vía limit/offset (no take/skip)', async () => {
      const qb = mockQb([]);
      await service.findAll('d1', {});
      expect(qb.limit).toHaveBeenCalledWith(10);
      expect(qb.offset).toHaveBeenCalledWith(0);
    });

    it('filtra por carId, deliveryId y status cuando vienen', async () => {
      const qb = mockQb([]);
      await service.findAll('d1', {
        carId: 'c1',
        deliveryId: 'dl1',
        status: MaintenanceTaskStatus.SCHEDULED,
      });
      expect(qb.andWhere).toHaveBeenCalledWith('task.car_id = :carId', {
        carId: 'c1',
      });
      expect(qb.andWhere).toHaveBeenCalledWith(
        'task.delivery_id = :deliveryId',
        { deliveryId: 'dl1' },
      );
      expect(qb.andWhere).toHaveBeenCalledWith('task.status = :status', {
        status: MaintenanceTaskStatus.SCHEDULED,
      });
    });
  });

  describe('close/cancel', () => {
    const abierta = (): MaintenanceTask =>
      ({
        taskId: 't1',
        distributorId: 'd1',
        status: MaintenanceTaskStatus.SCHEDULED,
        notes: null,
      }) as MaintenanceTask;

    it('cerrar registra lo hecho y pasa a DONE', async () => {
      tasks.findOne.mockResolvedValue(abierta());
      const cerrada = await service.close(
        't1',
        { performedAt: '2026-09-26T00:00:00.000Z', odometerKm: 50000 },
        'd1',
      );
      expect(cerrada.status).toBe(MaintenanceTaskStatus.DONE);
      expect(cerrada.odometerKm).toBe(50000);
    });

    it('no se puede cerrar una tarea ya cerrada', async () => {
      tasks.findOne.mockResolvedValue({
        ...abierta(),
        status: MaintenanceTaskStatus.DONE,
      });
      await expect(
        service.close('t1', { performedAt: '2026-09-26T00:00:00.000Z' }, 'd1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cancelar agrega el motivo a las notas', async () => {
      tasks.findOne.mockResolvedValue(abierta());
      const cancelada = await service.cancel(
        't1',
        { notes: 'ya no aplica' },
        'd1',
      );
      expect(cancelada.status).toBe(MaintenanceTaskStatus.CANCELLED);
      expect(cancelada.notes).toContain('ya no aplica');
    });
  });

  describe('listByCar / bloqueo', () => {
    it('un vehículo con una tarea bloqueante vencida queda inhabilitado', async () => {
      carService.findOne.mockResolvedValue({ carId: 'c1' });
      tasks.find.mockResolvedValue([
        {
          taskId: 't1',
          status: MaintenanceTaskStatus.SCHEDULED,
          dueAt: new Date('2020-01-01'),
          plan: planVehiculo,
        } as MaintenanceTask,
      ]);

      const { isLocked, tasks: lista } = await service.listByCar('c1', 'd1');
      expect(isLocked).toBe(true);
      expect(lista).toHaveLength(1);
    });

    it('una tarea vencida pero ya cerrada (DONE) no inhabilita', async () => {
      carService.findOne.mockResolvedValue({ carId: 'c1' });
      tasks.find.mockResolvedValue([
        {
          taskId: 't1',
          status: MaintenanceTaskStatus.DONE,
          dueAt: new Date('2020-01-01'),
          plan: planVehiculo,
        } as MaintenanceTask,
      ]);

      const { isLocked } = await service.listByCar('c1', 'd1');
      expect(isLocked).toBe(false);
    });

    it('un vehículo de otra distribuidora es 404', async () => {
      carService.findOne.mockRejectedValue(new NotFoundException());
      await expect(service.listByCar('c1', 'd1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('listByDelivery', () => {
    it('un chofer de otra distribuidora es 404', async () => {
      deliveryService.findOne.mockResolvedValue({
        deliveryId: 'dl1',
        distributorId: 'd2',
      });
      await expect(service.listByDelivery('dl1', 'd1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
