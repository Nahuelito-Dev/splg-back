import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { EmployeeDocumentsService } from './employee-documents.service';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from './entities/maintenance-task.entity';
import {
  MaintenanceCriticality,
  MaintenancePlan,
  MaintenanceSubject,
} from './entities/maintenance-plan.entity';
import { EmployeeService } from '../employee/employee.service';
import { DeliveryService } from '../delivery/delivery.service';
import { LeaveService } from '../leave/leave.service';
import { JobPositionCategory } from '../employee/entities/job-position.entity';

describe('EmployeeDocumentsService', () => {
  let service: EmployeeDocumentsService;
  let getMany: jest.Mock;
  let qb: Record<string, jest.Mock>;
  let plans: { find: jest.Mock };
  let employees: { findOne: jest.Mock; findActivos: jest.Mock };
  let deliveries: { findDeliveryIdsByUserIds: jest.Mock };
  let leaves: { empleadosDeLicenciaEn: jest.Mock };

  const chofer = {
    employeeId: 'e1',
    userId: 'u1',
    status: 'active',
    firstName: 'Ana',
    lastName: 'Pérez',
    position: { category: JobPositionCategory.DRIVER },
  };
  const deposito = {
    employeeId: 'e2',
    userId: null,
    status: 'active',
    firstName: 'Beto',
    lastName: 'Gómez',
    position: { category: JobPositionCategory.WAREHOUSE },
  };

  const plan = (over: Partial<MaintenancePlan> = {}): MaintenancePlan =>
    ({
      planId: 'p1',
      name: 'Examen psicofísico',
      subject: MaintenanceSubject.EMPLOYEE,
      criticality: MaintenanceCriticality.BLOCKING,
      leadTimeDays: 30,
      appliesToCategories: [JobPositionCategory.DRIVER],
      isActive: true,
      ...over,
    }) as MaintenancePlan;

  const tarea = (over: Record<string, unknown> = {}): MaintenanceTask =>
    ({
      taskId: 't1',
      planId: 'p1',
      employeeId: 'e1',
      deliveryId: null,
      status: MaintenanceTaskStatus.SCHEDULED,
      dueAt: new Date('2099-01-01'),
      plan: plan(),
      ...over,
    }) as unknown as MaintenanceTask;

  beforeEach(() => {
    getMany = jest.fn().mockResolvedValue([]);
    qb = {};
    for (const m of [
      'innerJoinAndSelect',
      'leftJoinAndSelect',
      'leftJoin',
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
    ]) {
      qb[m] = jest.fn().mockReturnValue(qb);
    }
    qb.getMany = getMany;
    plans = { find: jest.fn().mockResolvedValue([]) };
    employees = {
      findOne: jest.fn().mockResolvedValue(chofer),
      findActivos: jest.fn().mockResolvedValue([chofer]),
    };
    deliveries = {
      findDeliveryIdsByUserIds: jest
        .fn()
        .mockResolvedValue([{ userId: 'u1', deliveryId: 'dl1' }]),
    };
    leaves = {
      empleadosDeLicenciaEn: jest.fn().mockResolvedValue(new Set<string>()),
    };
    service = new EmployeeDocumentsService(
      {
        createQueryBuilder: jest.fn().mockReturnValue(qb),
      } as unknown as Repository<MaintenanceTask>,
      plans as unknown as Repository<MaintenancePlan>,
      employees as unknown as EmployeeService,
      deliveries as unknown as DeliveryService,
      leaves as unknown as LeaveService,
    );
  });

  describe('documentsOf (CU-187)', () => {
    it('un legajo de otra distribuidora es 404', async () => {
      employees.findOne.mockRejectedValue(new NotFoundException());
      await expect(service.documentsOf('e1', 'd2')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(employees.findOne).toHaveBeenCalledWith('e1', 'd2');
    });

    it('devuelve sus tareas y los planes activos que le aplican y no tiene cargados', async () => {
      const psicofisico = plan();
      const art = plan({
        planId: 'p2',
        name: 'Alta en ART',
        appliesToCategories: null,
        criticality: MaintenanceCriticality.NON_BLOCKING,
      });
      const curso = plan({ planId: 'p3', name: 'Curso GLP' });
      plans.find.mockResolvedValue([psicofisico, art, curso]);
      getMany.mockResolvedValue([tarea({ planId: 'p1' })]);

      const res = await service.documentsOf('e1', 'd1');

      expect(res.tasks).toHaveLength(1);
      expect(res.missingPlans.map((p) => p.planId)).toEqual(['p2', 'p3']);
      expect(res.isLocked).toBe(false);
    });

    it('la habilitación sigue la regla del despacho: licencia de hoy y legajo egresado también inhabilitan', async () => {
      plans.find.mockResolvedValue([]);
      leaves.empleadosDeLicenciaEn.mockResolvedValue(new Set(['e1']));
      const deLicencia = await service.documentsOf('e1', 'd1');
      expect(deLicencia.isLocked).toBe(true);
      expect(deLicencia.lockReasons).toEqual([
        'tiene una licencia aprobada que cubre el día de hoy',
      ]);

      leaves.empleadosDeLicenciaEn.mockResolvedValue(new Set());
      employees.findOne.mockResolvedValue({ ...chofer, status: 'terminated' });
      const egresado = await service.documentsOf('e1', 'd1');
      expect(egresado.lockReasons).toEqual(['su legajo está egresado']);
    });

    it('la documentación bloqueante vencida da el motivo con su fecha', async () => {
      plans.find.mockResolvedValue([plan()]);
      getMany.mockResolvedValue([
        tarea({ dueAt: new Date('2020-03-01T00:00:00Z') }),
      ]);
      const res = await service.documentsOf('e1', 'd1');
      expect(res.lockReasons).toEqual([
        'Examen psicofísico: venció el 01/03/2020',
      ]);
    });

    it('un plan de otra categoría no le falta', async () => {
      employees.findOne.mockResolvedValue(deposito);
      plans.find.mockResolvedValue([
        plan(),
        plan({ planId: 'p2', appliesToCategories: null }),
      ]);

      const res = await service.documentsOf('e2', 'd1');

      expect(res.missingPlans.map((p) => p.planId)).toEqual(['p2']);
    });

    it('una tarea cerrada no cuenta como cargada, y una bloqueante vencida lo inhabilita', async () => {
      plans.find.mockResolvedValue([plan()]);
      getMany.mockResolvedValue([
        tarea({ status: MaintenanceTaskStatus.DONE }),
        tarea({ taskId: 't2', dueAt: new Date('2020-01-01') }),
      ]);

      const res = await service.documentsOf('e1', 'd1');
      expect(res.isLocked).toBe(true);
      expect(res.missingPlans).toEqual([]); // la abierta (vencida) cubre el plan

      getMany.mockResolvedValue([
        tarea({ status: MaintenanceTaskStatus.DONE }),
      ]);
      const cerrada = await service.documentsOf('e1', 'd1');
      expect(cerrada.isLocked).toBe(false);
      expect(cerrada.missingPlans).toHaveLength(1);
    });

    it('la licencia del perfil de reparto (plan de chofer) también cuenta como cargada', async () => {
      const licencia = plan({
        planId: 'pl',
        name: 'Licencia de conducir',
        subject: MaintenanceSubject.DRIVER,
        appliesToCategories: null,
      });
      plans.find.mockResolvedValue([licencia]);
      getMany.mockResolvedValue([
        tarea({
          planId: 'pl',
          employeeId: null,
          deliveryId: 'dl1',
          plan: licencia,
        }),
      ]);

      const res = await service.documentsOf('e1', 'd1');
      expect(res.missingPlans).toEqual([]);
    });

    it('un plan de chofer sin categorías sólo le aplica a un chofer', async () => {
      const licencia = plan({
        planId: 'pl',
        subject: MaintenanceSubject.DRIVER,
        appliesToCategories: null,
      });
      plans.find.mockResolvedValue([licencia]);
      employees.findOne.mockResolvedValue(deposito);

      const res = await service.documentsOf('e2', 'd1');
      expect(res.missingPlans).toEqual([]);
    });
  });

  describe('faltantesBloqueantesDeChoferes (CU-188)', () => {
    it('sin choferes activos no consulta nada más', async () => {
      employees.findActivos.mockResolvedValue([]);
      await expect(
        service.faltantesBloqueantesDeChoferes('d1'),
      ).resolves.toEqual([]);
      expect(plans.find).not.toHaveBeenCalled();
    });

    it('lista a los choferes a los que les falta un plan bloqueante y deja de lado los no bloqueantes', async () => {
      plans.find.mockResolvedValue([
        plan(),
        plan({
          planId: 'p2',
          name: 'Alta en ART',
          criticality: MaintenanceCriticality.NON_BLOCKING,
          appliesToCategories: null,
        }),
      ]);
      getMany.mockResolvedValue([]);

      const res = await service.faltantesBloqueantesDeChoferes('d1');

      expect(res).toHaveLength(1);
      expect(res[0].empleado.employeeId).toBe('e1');
      expect(res[0].planes.map((p) => p.planId)).toEqual(['p1']);
    });

    it('un chofer que tiene cargado el plan no figura', async () => {
      plans.find.mockResolvedValue([plan()]);
      getMany.mockResolvedValue([tarea()]);

      await expect(
        service.faltantesBloqueantesDeChoferes('d1'),
      ).resolves.toEqual([]);
    });

    it('la licencia cargada en su perfil de reparto cubre el plan de chofer', async () => {
      const licencia = plan({
        planId: 'pl',
        subject: MaintenanceSubject.DRIVER,
        appliesToCategories: [JobPositionCategory.DRIVER],
      });
      plans.find.mockResolvedValue([licencia]);
      getMany.mockResolvedValue([
        tarea({
          planId: 'pl',
          employeeId: null,
          deliveryId: 'dl1',
          delivery: { userId: 'u1' },
          plan: licencia,
        }),
      ]);

      await expect(
        service.faltantesBloqueantesDeChoferes('d1'),
      ).resolves.toEqual([]);
    });
  });

  describe('contarPorEstadoDeVencimiento (CU-194)', () => {
    it('cuenta las abiertas por vigente, por vencer y vencida', async () => {
      const hoy = Date.now();
      getMany.mockResolvedValue([
        tarea({ dueAt: new Date(hoy + 200 * 86_400_000) }),
        tarea({ dueAt: new Date(hoy + 5 * 86_400_000) }),
        tarea({ dueAt: new Date(hoy + 6 * 86_400_000) }),
        tarea({ dueAt: new Date('2020-01-01') }),
      ]);

      await expect(service.contarPorEstadoDeVencimiento('d1')).resolves.toEqual(
        {
          current: 1,
          due_soon: 2,
          expired: 1,
        },
      );
    });
  });
});
