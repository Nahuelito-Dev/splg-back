import {
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { CashDocumentPaymentService } from '../cash/application/cash-document-payment.service';
import { CarService } from '../car/car.service';
import { DeliveryService } from '../delivery/delivery.service';
import { EmployeeService } from '../employee/employee.service';
import {
  MaintenanceCriticality,
  MaintenancePlan,
  MaintenanceSubject,
  MaintenanceTrigger,
} from './entities/maintenance-plan.entity';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from './entities/maintenance-task.entity';
import { FleetDispatchLockService } from './fleet-dispatch-lock.service';
import { FleetTaskBoardNotifier } from './fleet-task-board.notifier';
import { FleetTaskService } from './fleet-task.service';
import { PlanningCaseCloser } from './planner/planning-case-closer.service';

/**
 * Lo del tablero en el servicio de tareas: el responsable, la precondición de
 * la edición y el aviso `fleet:task` después de confirmar cada escritura.
 */
describe('FleetTaskService: tablero', () => {
  const ACTUALIZADA = new Date('2026-11-17T12:00:00.123Z');
  const plan = {
    planId: 'plan-vtv',
    distributorId: 'd1',
    name: 'VTV',
    subject: MaintenanceSubject.VEHICLE,
    trigger: MaintenanceTrigger.BY_FIXED_DATE,
    leadTimeDays: 30,
    criticality: MaintenanceCriticality.BLOCKING,
    documentKind: null,
    isActive: true,
  } as unknown as MaintenancePlan;

  let service: FleetTaskService;
  let fila: MaintenanceTask;
  let orden: string[];
  let transaccionFalla: Error | null;
  let tasks: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let employees: { findActivo: jest.Mock };
  let carService: { findOne: jest.Mock; actualizarOdometro: jest.Mock };
  let tablero: { avisar: jest.Mock };

  beforeEach(() => {
    orden = [];
    transaccionFalla = null;
    fila = {
      taskId: 't1',
      distributorId: 'd1',
      planId: 'plan-vtv',
      status: MaintenanceTaskStatus.SCHEDULED,
      scheduledAt: null,
      dueAt: null,
      validFrom: null,
      notes: null,
      odometerKm: null,
      carId: null,
      updatedAt: ACTUALIZADA,
    } as MaintenanceTask;
    const bloqueo = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn(() => Promise.resolve(fila)),
    };
    const plans = {
      findOne: jest.fn().mockResolvedValue(plan),
      findOneOrFail: jest.fn().mockResolvedValue(plan),
    };
    tasks = {
      create: jest.fn((t: Partial<MaintenanceTask>) => t),
      save: jest.fn((t: MaintenanceTask) => {
        orden.push('save');
        return Promise.resolve({ ...t, taskId: t.taskId ?? 'nueva' });
      }),
      findOne: jest.fn(() => Promise.resolve({ ...fila, plan })),
      createQueryBuilder: jest.fn(() => bloqueo),
      manager: {
        transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) => {
          const r = await cb({
            getRepository: (entidad: unknown) =>
              entidad === MaintenancePlan ? plans : tasks,
          });
          if (transaccionFalla) throw transaccionFalla;
          orden.push('commit');
          return r;
        }),
      },
    };
    employees = { findActivo: jest.fn().mockResolvedValue({}) };
    carService = {
      findOne: jest.fn().mockResolvedValue({}),
      actualizarOdometro: jest.fn(),
    };
    tablero = {
      avisar: jest.fn(() => {
        orden.push('aviso');
        return Promise.resolve();
      }),
    };
    service = new FleetTaskService(
      tasks as unknown as Repository<MaintenanceTask>,
      plans as unknown as Repository<MaintenancePlan>,
      carService as unknown as CarService,
      {} as DeliveryService,
      employees as unknown as EmployeeService,
      {} as FleetDispatchLockService,
      {} as CashDocumentPaymentService,
      undefined as unknown as PlanningCaseCloser,
      tablero as unknown as FleetTaskBoardNotifier,
    );
  });

  describe('alta', () => {
    it('con responsable: lo valida en la empresa, lo guarda y avisa `created` después de guardar', async () => {
      await service.create(
        { planId: 'plan-vtv', carId: 'c1', assigneeEmployeeId: 'e1' },
        'd1',
      );
      expect(employees.findActivo).toHaveBeenCalledWith('e1', 'd1');
      expect(tasks.create).toHaveBeenCalledWith(
        expect.objectContaining({ assigneeEmployeeId: 'e1' }),
      );
      expect(tablero.avisar).toHaveBeenCalledWith('d1', 'nueva', 'created');
      expect(orden).toEqual(['save', 'aviso']);
    });

    it('sin responsable no consulta legajos y lo deja vacío', async () => {
      await service.create({ planId: 'plan-vtv', carId: 'c1' }, 'd1');
      expect(employees.findActivo).not.toHaveBeenCalled();
      expect(tasks.create).toHaveBeenCalledWith(
        expect.objectContaining({ assigneeEmployeeId: null }),
      );
    });

    it('un responsable de otra empresa: 404 y no guarda ni avisa', async () => {
      employees.findActivo.mockRejectedValue(
        new NotFoundException('Empleado no encontrado'),
      );
      await expect(
        service.create(
          { planId: 'plan-vtv', carId: 'c1', assigneeEmployeeId: 'e9' },
          'd1',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tasks.save).not.toHaveBeenCalled();
      expect(tablero.avisar).not.toHaveBeenCalled();
    });
  });

  describe('edición', () => {
    it('cambia el responsable validándolo con la fila bloqueada, y avisa `updated` después del commit', async () => {
      await service.update('t1', { notes: 'x' }, 'd1', 'u1', {
        assigneeEmployeeId: 'e2',
      });
      expect(employees.findActivo).toHaveBeenCalledWith(
        'e2',
        'd1',
        expect.anything(),
      );
      expect((tasks.save.mock.calls[0] as unknown[])[0]).toMatchObject({
        assigneeEmployeeId: 'e2',
        notes: 'x',
      });
      expect(orden).toEqual(['save', 'commit', 'aviso']);
      expect(tablero.avisar).toHaveBeenCalledWith('d1', 't1', 'updated');
    });

    it('reenviar el mismo responsable no vuelve a validar ni a bloquear el legajo', async () => {
      fila.assigneeEmployeeId = 'e1';
      await service.update('t1', { notes: 'x' }, 'd1', 'u1', {
        assigneeEmployeeId: 'e1',
      });
      expect(employees.findActivo).not.toHaveBeenCalled();
      expect(tasks.save).toHaveBeenCalled();
    });

    it('`null` quita el responsable sin consultar legajos', async () => {
      fila.assigneeEmployeeId = 'e1';
      await service.update('t1', {}, 'd1', 'u1', { assigneeEmployeeId: null });
      expect(employees.findActivo).not.toHaveBeenCalled();
      expect((tasks.save.mock.calls[0] as unknown[])[0]).toMatchObject({
        assigneeEmployeeId: null,
      });
    });

    it('sin el campo, el responsable no se toca', async () => {
      fila.assigneeEmployeeId = 'e1';
      await service.update('t1', { notes: 'y' }, 'd1');
      expect((tasks.save.mock.calls[0] as unknown[])[0]).toMatchObject({
        assigneeEmployeeId: 'e1',
      });
    });

    it('precondición vieja: 409 FLEET_TASK_STALE, no guarda ni avisa', async () => {
      const error: unknown = await service
        .update('t1', { notes: 'x' }, 'd1', 'u1', {
          expectedUpdatedAt: new Date('2026-11-17T11:00:00.000Z'),
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(ConflictException);
      expect(
        ((error as HttpException).getResponse() as { code: string }).code,
      ).toBe('FLEET_TASK_STALE');
      expect(tasks.save).not.toHaveBeenCalled();
      expect(tablero.avisar).not.toHaveBeenCalled();
    });

    it('precondición al día: edita', async () => {
      await service.update('t1', { notes: 'x' }, 'd1', 'u1', {
        expectedUpdatedAt: new Date(ACTUALIZADA.getTime()),
      });
      expect(tasks.save).toHaveBeenCalled();
    });

    it('si la transacción falla no avisa', async () => {
      transaccionFalla = new ConflictException('chocó');
      await expect(service.update('t1', { notes: 'x' }, 'd1')).rejects.toBe(
        transaccionFalla,
      );
      expect(tablero.avisar).not.toHaveBeenCalled();
    });
  });

  it('cerrar avisa `closed` después del commit', async () => {
    await service.close(
      't1',
      { performedAt: '2026-11-01T00:00:00.000Z' },
      'd1',
    );
    expect(orden).toEqual(['save', 'commit', 'aviso']);
    expect(tablero.avisar).toHaveBeenCalledWith('d1', 't1', 'closed');
  });

  it('cancelar avisa `cancelled` después del commit', async () => {
    await service.cancel('t1', { notes: 'no aplica' }, 'd1');
    expect(orden).toEqual(['save', 'commit', 'aviso']);
    expect(tablero.avisar).toHaveBeenCalledWith('d1', 't1', 'cancelled');
  });

  it('un cierre que falla no avisa', async () => {
    fila.status = MaintenanceTaskStatus.DONE;
    await expect(
      service.close('t1', { performedAt: '2026-11-01T00:00:00.000Z' }, 'd1'),
    ).rejects.toBeInstanceOf(HttpException);
    expect(tablero.avisar).not.toHaveBeenCalled();
  });
});
