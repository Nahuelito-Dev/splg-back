import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { FleetTaskService } from './fleet-task.service';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from './entities/maintenance-task.entity';
import {
  MaintenanceCriticality,
  MaintenanceDocumentKind,
  MaintenancePlan,
  MaintenanceSubject,
  MaintenanceTrigger,
} from './entities/maintenance-plan.entity';
import { CarService } from '../car/car.service';
import { DeliveryService } from '../delivery/delivery.service';
import { FleetDispatchLockService } from './fleet-dispatch-lock.service';
import { EmployeeService } from '../employee/employee.service';
import { JobPositionCategory } from '../employee/entities/job-position.entity';

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
  let fleetLock: { choferesInhabilitados: jest.Mock };
  let employees: { findActivo: jest.Mock };

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
    fleetLock = {
      choferesInhabilitados: jest.fn().mockResolvedValue(new Set()),
    };

    employees = { findActivo: jest.fn() };

    service = new FleetTaskService(
      tasks as unknown as Repository<MaintenanceTask>,
      plans as unknown as Repository<MaintenancePlan>,
      carService as unknown as CarService,
      deliveryService as unknown as DeliveryService,
      employees as unknown as EmployeeService,
      fleetLock as unknown as FleetDispatchLockService,
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

    it('un dueAt con hora se normaliza a medianoche UTC de la misma fecha (revisión de vehículo en uso)', async () => {
      plans.findOne.mockResolvedValue(planVehiculo);
      carService.findOne.mockResolvedValue({
        carId: 'c1',
        distributorId: 'd1',
      });

      const task = await service.create(
        { planId: 'plan-vtv', carId: 'c1', dueAt: '2026-12-01T14:30:00.000Z' },
        'd1',
      );

      expect(task.dueAt).toEqual(new Date('2026-12-01T00:00:00.000Z'));
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

    describe('documentación del personal (CU-183 a CU-185)', () => {
      const planCurso = {
        ...planVehiculo,
        planId: 'plan-curso',
        name: 'Curso de transporte de mercancías peligrosas (GLP)',
        subject: MaintenanceSubject.EMPLOYEE,
        documentKind: MaintenanceDocumentKind.HAZMAT_DRIVER_COURSE,
        appliesToCategories: [JobPositionCategory.DRIVER],
        leadTimeDays: 60,
      } as unknown as MaintenancePlan;
      const planArt = {
        ...planCurso,
        planId: 'plan-art',
        name: 'Alta en ART',
        documentKind: MaintenanceDocumentKind.ART_COVERAGE,
        appliesToCategories: null,
        criticality: MaintenanceCriticality.NON_BLOCKING,
      } as unknown as MaintenancePlan;
      const chofer = {
        employeeId: 'e1',
        position: { category: JobPositionCategory.DRIVER },
      };
      const deposito = {
        employeeId: 'e2',
        position: { category: JobPositionCategory.WAREHOUSE },
      };
      const detalleCurso = { certificateNumber: '123/26', issuer: 'CNRT' };

      it('registra el curso del chofer con su vencimiento y su detalle', async () => {
        plans.findOne.mockResolvedValue(planCurso);
        employees.findActivo.mockResolvedValue(chofer);

        const task = await service.create(
          {
            planId: 'plan-curso',
            employeeId: 'e1',
            dueAt: '2027-05-10T15:00:00.000Z',
            details: detalleCurso,
          },
          'd1',
        );

        expect(employees.findActivo).toHaveBeenCalledWith('e1', 'd1');
        expect(task).toMatchObject({
          employeeId: 'e1',
          carId: null,
          deliveryId: null,
          details: detalleCurso,
          dueAt: new Date('2027-05-10T00:00:00.000Z'),
        });
      });

      it('la ART aplica a cualquier categoría', async () => {
        plans.findOne.mockResolvedValue(planArt);
        employees.findActivo.mockResolvedValue(deposito);

        const task = await service.create(
          {
            planId: 'plan-art',
            employeeId: 'e2',
            dueAt: '2027-05-10T00:00:00.000Z',
            details: { insurer: 'Galeno', policyNumber: '99' },
          },
          'd1',
        );

        expect(task.employeeId).toBe('e2');
      });

      it('un plan que no aplica a la categoría del puesto se rechaza (400)', async () => {
        plans.findOne.mockResolvedValue(planCurso);
        employees.findActivo.mockResolvedValue(deposito);

        await expect(
          service.create(
            {
              planId: 'plan-curso',
              employeeId: 'e2',
              dueAt: '2027-05-10T00:00:00.000Z',
              details: detalleCurso,
            },
            'd1',
          ),
        ).rejects.toThrow(/no aplica a la categoría/);
        expect(tasks.save).not.toHaveBeenCalled();
      });

      it('un detalle con otra forma se rechaza nombrando el campo (400)', async () => {
        plans.findOne.mockResolvedValue(planCurso);
        employees.findActivo.mockResolvedValue(chofer);

        await expect(
          service.create(
            {
              planId: 'plan-curso',
              employeeId: 'e1',
              dueAt: '2027-05-10T00:00:00.000Z',
              details: { certificateNumber: '123/26' },
            },
            'd1',
          ),
        ).rejects.toThrow(/detalle\.issuer/);
        expect(tasks.save).not.toHaveBeenCalled();
      });

      it('sin vencimiento no se registra (400)', async () => {
        plans.findOne.mockResolvedValue(planCurso);
        employees.findActivo.mockResolvedValue(chofer);

        await expect(
          service.create(
            { planId: 'plan-curso', employeeId: 'e1', details: detalleCurso },
            'd1',
          ),
        ).rejects.toThrow(/dueAt/);
      });

      it('un plan inactivo se rechaza (400)', async () => {
        plans.findOne.mockResolvedValue({ ...planCurso, isActive: false });
        employees.findActivo.mockResolvedValue(chofer);

        await expect(
          service.create(
            {
              planId: 'plan-curso',
              employeeId: 'e1',
              dueAt: '2027-05-10T00:00:00.000Z',
              details: detalleCurso,
            },
            'd1',
          ),
        ).rejects.toThrow(/inactivo/);
      });

      it('un legajo de otra distribuidora (404) o egresado (409) viene de EmployeeService', async () => {
        plans.findOne.mockResolvedValue(planCurso);
        const cuerpo = {
          planId: 'plan-curso',
          employeeId: 'e1',
          dueAt: '2027-05-10T00:00:00.000Z',
          details: detalleCurso,
        };

        employees.findActivo.mockRejectedValue(new NotFoundException());
        await expect(service.create(cuerpo, 'd1')).rejects.toBeInstanceOf(
          NotFoundException,
        );
        employees.findActivo.mockRejectedValue(new ConflictException());
        await expect(service.create(cuerpo, 'd1')).rejects.toBeInstanceOf(
          ConflictException,
        );
      });

      it('un plan de personal sin employeeId, o con carId, es 400', async () => {
        plans.findOne.mockResolvedValue(planCurso);
        await expect(
          service.create({ planId: 'plan-curso' }, 'd1'),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          service.create(
            { planId: 'plan-curso', employeeId: 'e1', carId: 'c1' },
            'd1',
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('un plan de vehículo con employeeId es 400, y un detalle donde no corresponde también', async () => {
        plans.findOne.mockResolvedValue(planVehiculo);
        await expect(
          service.create(
            { planId: 'plan-vtv', carId: 'c1', employeeId: 'e1' },
            'd1',
          ),
        ).rejects.toBeInstanceOf(BadRequestException);

        carService.findOne.mockResolvedValue({ carId: 'c1' });
        plans.findOne.mockResolvedValue({
          ...planVehiculo,
          documentKind: MaintenanceDocumentKind.VTV,
        });
        await expect(
          service.create(
            { planId: 'plan-vtv', carId: 'c1', details: { x: 'y' } },
            'd1',
          ),
        ).rejects.toThrow(/no lleva detalle/);
      });
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
        addOrderBy: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(42),
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

    it('devuelve el total de los filtros, sin paginar', async () => {
      mockQb([]);
      const [, total] = await service.findAll('d1', { limit: 5 });
      expect(total).toBe(42);
    });

    it('ordena por vencimiento con NULLS LAST explícito y desempata por id', async () => {
      const qb = mockQb([]);
      await service.findAll('d1', {});
      expect(qb.orderBy).toHaveBeenCalledWith(
        'task.due_at',
        'ASC',
        'NULLS LAST',
      );
      expect(qb.addOrderBy).toHaveBeenCalledWith('task.task_id', 'ASC');
    });

    it('filtra por planId', async () => {
      const qb = mockQb([]);
      await service.findAll('d1', { planId: 'p1' });
      expect(qb.andWhere).toHaveBeenCalledWith('task.plan_id = :planId', {
        planId: 'p1',
      });
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

  describe('update: el detalle del documento', () => {
    const planCurso = {
      ...planVehiculo,
      subject: MaintenanceSubject.EMPLOYEE,
      documentKind: MaintenanceDocumentKind.HAZMAT_DRIVER_COURSE,
    } as unknown as MaintenancePlan;
    const abierta = () =>
      ({
        taskId: 't1',
        distributorId: 'd1',
        status: MaintenanceTaskStatus.SCHEDULED,
        plan: planCurso,
        details: { certificateNumber: '1', issuer: 'CNRT' },
      }) as unknown as MaintenanceTask;

    it('corrige el detalle validado contra el tipo de documento del plan', async () => {
      tasks.findOne.mockResolvedValue(abierta());

      const res = await service.update(
        't1',
        { details: { certificateNumber: '2', issuer: 'CNRT' } },
        'd1',
      );

      expect(res.details).toEqual({ certificateNumber: '2', issuer: 'CNRT' });
    });

    it('un detalle con otra forma es 400 y no se guarda', async () => {
      tasks.findOne.mockResolvedValue(abierta());

      await expect(
        service.update('t1', { details: { certificateNumber: '2' } }, 'd1'),
      ).rejects.toThrow(/detalle\.issuer/);
      expect(tasks.save).not.toHaveBeenCalled();
    });

    it('sin details en el cuerpo, el detalle no se toca', async () => {
      tasks.findOne.mockResolvedValue(abierta());

      const res = await service.update('t1', { notes: 'x' }, 'd1');

      expect(res.details).toEqual({ certificateNumber: '1', issuer: 'CNRT' });
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

  /**
   * CU-136/137: el chequeo que corre `DeliveryVehicleController` ANTES de
   * poner un vehículo en uso (decisión de nahue del 30/09).
   */
  describe('motivosDeInhabilitacionDeVehiculo / assertVehiculoHabilitado', () => {
    it('describe qué está vencido, en castellano y con fecha', async () => {
      carService.findOne.mockResolvedValue({ carId: 'c1' });
      tasks.find.mockResolvedValue([
        {
          taskId: 't1',
          status: MaintenanceTaskStatus.SCHEDULED,
          dueAt: new Date('2021-06-15T00:00:00.000Z'),
          plan: planVehiculo, // name: 'VTV'
        } as MaintenanceTask,
      ]);

      const motivos = await service.motivosDeInhabilitacionDeVehiculo(
        'c1',
        'd1',
      );

      expect(motivos).toEqual(['VTV: venció el 15/06/2021']);
    });

    it('un vehículo en condiciones no tiene motivos', async () => {
      carService.findOne.mockResolvedValue({ carId: 'c1' });
      tasks.find.mockResolvedValue([]);

      const motivos = await service.motivosDeInhabilitacionDeVehiculo(
        'c1',
        'd1',
      );
      expect(motivos).toEqual([]);
    });

    it('assertVehiculoHabilitado rechaza con 400 si hay algo vencido', async () => {
      carService.findOne.mockResolvedValue({ carId: 'c1' });
      tasks.find.mockResolvedValue([
        {
          taskId: 't1',
          status: MaintenanceTaskStatus.SCHEDULED,
          dueAt: new Date('2021-06-15T00:00:00.000Z'),
          plan: planVehiculo,
        } as MaintenanceTask,
      ]);

      await expect(
        service.assertVehiculoHabilitado('c1', 'd1'),
      ).rejects.toThrow('No se puede asignar: VTV: venció el 15/06/2021.');
    });

    it('assertVehiculoHabilitado no hace nada si el vehículo está en condiciones', async () => {
      carService.findOne.mockResolvedValue({ carId: 'c1' });
      tasks.find.mockResolvedValue([]);

      await expect(
        service.assertVehiculoHabilitado('c1', 'd1'),
      ).resolves.toBeUndefined();
    });
  });

  /**
   * CU-138 + coherencia con el despacho (revisión cruzada): `isLocked` sale
   * del MISMO gate que usa `DispatchOrchestratorService`
   * (`FleetDispatchLockService.choferesInhabilitados`), no sólo de las
   * tareas propias del chofer. Un chofer sin ninguna tarea propia vencida
   * puede seguir apareciendo bloqueado si el gate dice que su vehículo sí lo
   * está.
   */
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

    it('isLocked sale del gate compartido con el despacho, por user_id', async () => {
      deliveryService.findOne.mockResolvedValue({
        deliveryId: 'dl1',
        userId: 'user-1',
        distributorId: 'd1',
      });
      tasks.find.mockResolvedValue([]); // sin tareas propias (licencia) vencidas
      fleetLock.choferesInhabilitados.mockResolvedValue(new Set(['user-1']));

      const { isLocked } = await service.listByDelivery('dl1', 'd1');

      expect(isLocked).toBe(true);
      expect(fleetLock.choferesInhabilitados).toHaveBeenCalledWith(
        ['user-1'],
        'd1',
      );
    });

    it('sin nada vencido (propio ni del vehículo), isLocked es false', async () => {
      deliveryService.findOne.mockResolvedValue({
        deliveryId: 'dl2',
        userId: 'user-2',
        distributorId: 'd1',
      });
      tasks.find.mockResolvedValue([]);
      fleetLock.choferesInhabilitados.mockResolvedValue(new Set());

      const { isLocked } = await service.listByDelivery('dl2', 'd1');

      expect(isLocked).toBe(false);
    });
  });
});
