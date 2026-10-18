import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { FleetDispatchLockService } from './fleet-dispatch-lock.service';
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
import { VehicleAssignmentService } from '../car/vehicle-assignment.service';
import { DeliveryService } from '../delivery/delivery.service';
import { EmployeeService } from '../employee/employee.service';
import { EmployeeStatus } from '../employee/entities/employee.entity';
import { LeaveService } from '../leave/leave.service';

/**
 * Un `FindOptionsWhere` real de TypeORM (arreglo de condiciones OR, cada una
 * un AND de columnas). Evalúa `In(...)`/`Not(In(...))` — los únicos
 * operadores que usa `FleetDispatchLockService` — contra una fila "de base"
 * de prueba. A diferencia de un `jest.fn().mockResolvedValue(...)` que
 * ignora el `where`, esto SÍ filtra según lo que la producción pida: si se
 * borra el filtro de estado o el de distribuidora, una fila que hoy queda
 * afuera empieza a entrar, y el resultado observable cambia.
 */
function crearRepoFake(filasDeLaBase: MaintenanceTask[]) {
  const find = jest.fn(
    (opciones: {
      where: Record<string, unknown> | Record<string, unknown>[];
    }) => {
      const condiciones = Array.isArray(opciones.where)
        ? opciones.where
        : [opciones.where];
      const resultado = filasDeLaBase.filter((fila) =>
        condiciones.some((condicion) =>
          Object.entries(condicion).every(([columna, esperado]) =>
            cumpleCondicion(
              esperado,
              (fila as unknown as Record<string, unknown>)[columna],
            ),
          ),
        ),
      );
      return Promise.resolve(resultado);
    },
  );
  return { find };
}

function cumpleCondicion(esperado: unknown, valorReal: unknown): boolean {
  if (esperado && typeof esperado === 'object' && 'type' in esperado) {
    const operador = esperado as { type: string; value: unknown };
    if (operador.type === 'in') {
      return (
        Array.isArray(operador.value) && operador.value.includes(valorReal)
      );
    }
    if (operador.type === 'not') {
      // Este servicio sólo usa `Not(In(...))`: mismo IN, negado.
      return (
        Array.isArray(operador.value) && !operador.value.includes(valorReal)
      );
    }
  }
  return esperado === valorReal;
}

describe('FleetDispatchLockService', () => {
  let service: FleetDispatchLockService;
  let tasks: { find: jest.Mock };
  let vehicleAssignments: { findVehiculosEnUsoPorDeliveryIds: jest.Mock };
  let deliveryService: { findDeliveryIdsByUserIds: jest.Mock };
  let employees: { findByUserIds: jest.Mock };
  let leaves: { empleadosDeLicenciaEn: jest.Mock };

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

  const planLicencia: MaintenancePlan = {
    ...planVehiculo,
    planId: 'plan-licencia',
    name: 'Licencia de conducir',
    subject: MaintenanceSubject.DRIVER,
  };

  const tareaLicenciaVencida = {
    taskId: 't-licencia',
    carId: null,
    deliveryId: 'dl1',
    distributorId: 'd1',
    status: MaintenanceTaskStatus.SCHEDULED,
    dueAt: new Date('2020-01-01T00:00:00.000Z'),
    plan: planLicencia,
  } as unknown as MaintenanceTask;

  const tareaVtvVencida = {
    taskId: 't-vtv',
    carId: 'c1',
    deliveryId: null,
    distributorId: 'd1',
    status: MaintenanceTaskStatus.SCHEDULED,
    dueAt: new Date('2021-06-15T00:00:00.000Z'),
    plan: planVehiculo,
  } as unknown as MaintenanceTask;

  /** El vehículo en uso "normal" (sin nada vencido), para isolar otros casos. */
  const vehiculoEnUso = (deliveryId: string, carId = 'c-ok') => ({
    deliveryId,
    carId,
    patent: 'AB123CD',
    brand: 'Honda',
    model: 'Wave',
  });

  beforeEach(() => {
    tasks = { find: jest.fn().mockResolvedValue([]) };
    vehicleAssignments = {
      findVehiculosEnUsoPorDeliveryIds: jest.fn().mockResolvedValue([]),
    };
    deliveryService = {
      findDeliveryIdsByUserIds: jest.fn().mockResolvedValue([]),
    };

    employees = { findByUserIds: jest.fn().mockResolvedValue([]) };
    leaves = {
      empleadosDeLicenciaEn: jest.fn().mockResolvedValue(new Set<string>()),
    };

    service = new FleetDispatchLockService(
      tasks as unknown as Repository<MaintenanceTask>,
      vehicleAssignments as unknown as VehicleAssignmentService,
      deliveryService as unknown as DeliveryService,
      employees as unknown as EmployeeService,
      leaves as unknown as LeaveService,
    );
  });

  describe('choferesInhabilitados', () => {
    it('sin choferes para consultar, no hace ninguna consulta', async () => {
      const inhabilitados = await service.choferesInhabilitados([], 'd1');
      expect(inhabilitados.size).toBe(0);
      expect(deliveryService.findDeliveryIdsByUserIds).not.toHaveBeenCalled();
      expect(
        vehicleAssignments.findVehiculosEnUsoPorDeliveryIds,
      ).not.toHaveBeenCalled();
      expect(tasks.find).not.toHaveBeenCalled();
    });

    it('un chofer SIN vehículo en uso queda inhabilitado', async () => {
      deliveryService.findDeliveryIdsByUserIds.mockResolvedValue([
        { userId: 'user-0', deliveryId: 'dl0' },
      ]);
      // Sin vehículo en uso: findVehiculosEnUsoPorDeliveryIds devuelve [].

      const inhabilitados = await service.choferesInhabilitados(
        ['user-0'],
        'd1',
      );

      expect(inhabilitados.has('user-0')).toBe(true);
    });

    it('un chofer con su propia licencia vencida queda inhabilitado (aunque su vehículo esté en condiciones)', async () => {
      deliveryService.findDeliveryIdsByUserIds.mockResolvedValue([
        { userId: 'user-1', deliveryId: 'dl1' },
      ]);
      vehicleAssignments.findVehiculosEnUsoPorDeliveryIds.mockResolvedValue([
        vehiculoEnUso('dl1'),
      ]);
      tasks.find.mockResolvedValue([tareaLicenciaVencida]);

      const inhabilitados = await service.choferesInhabilitados(
        ['user-1'],
        'd1',
      );

      expect(inhabilitados.has('user-1')).toBe(true);
      expect(tasks.find).toHaveBeenCalledTimes(1); // una sola consulta en lote
    });

    it('un chofer cuyo vehículo EN USO tiene el VTV vencido queda inhabilitado', async () => {
      deliveryService.findDeliveryIdsByUserIds.mockResolvedValue([
        { userId: 'user-2', deliveryId: 'dl2' },
      ]);
      vehicleAssignments.findVehiculosEnUsoPorDeliveryIds.mockResolvedValue([
        vehiculoEnUso('dl2', 'c1'),
      ]);
      tasks.find.mockResolvedValue([tareaVtvVencida]);

      const inhabilitados = await service.choferesInhabilitados(
        ['user-2'],
        'd1',
      );

      expect(inhabilitados.has('user-2')).toBe(true);
    });

    it('un documento "por vencer" NO inhabilita', async () => {
      deliveryService.findDeliveryIdsByUserIds.mockResolvedValue([
        { userId: 'user-3', deliveryId: 'dl3' },
      ]);
      vehicleAssignments.findVehiculosEnUsoPorDeliveryIds.mockResolvedValue([
        vehiculoEnUso('dl3'),
      ]);
      tasks.find.mockResolvedValue([
        {
          ...tareaLicenciaVencida,
          deliveryId: 'dl3',
          dueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), // vence en 5 días, dentro del lead time
        },
      ]);

      const inhabilitados = await service.choferesInhabilitados(
        ['user-3'],
        'd1',
      );

      expect(inhabilitados.has('user-3')).toBe(false);
    });

    it('una tarea no bloqueante vencida (service) del vehículo en uso NO inhabilita', async () => {
      deliveryService.findDeliveryIdsByUserIds.mockResolvedValue([
        { userId: 'user-4', deliveryId: 'dl4' },
      ]);
      vehicleAssignments.findVehiculosEnUsoPorDeliveryIds.mockResolvedValue([
        vehiculoEnUso('dl4', 'c4'),
      ]);
      tasks.find.mockResolvedValue([
        {
          taskId: 't-service',
          carId: 'c4',
          deliveryId: null,
          distributorId: 'd1',
          status: MaintenanceTaskStatus.SCHEDULED,
          dueAt: new Date('2020-01-01'),
          plan: {
            ...planVehiculo,
            criticality: MaintenanceCriticality.NON_BLOCKING,
          },
        } as unknown as MaintenanceTask,
      ]);

      const inhabilitados = await service.choferesInhabilitados(
        ['user-4'],
        'd1',
      );

      expect(inhabilitados.has('user-4')).toBe(false);
    });

    /**
     * Control de mutación (revisión cruzada, punto 2): con el repo FAKE de
     * arriba, esto falla de verdad si se borra `status: Not(In(ESTADOS_CERRADOS))`
     * de `tareasAbiertasDe` — la tarea CERRADA pasaría el filtro y el chofer
     * quedaría inhabilitado por algo que ya está hecho.
     */
    it('una tarea bloqueante vencida pero YA CERRADA (done) no inhabilita', async () => {
      deliveryService.findDeliveryIdsByUserIds.mockResolvedValue([
        { userId: 'user-5', deliveryId: 'dl5' },
      ]);
      vehicleAssignments.findVehiculosEnUsoPorDeliveryIds.mockResolvedValue([
        vehiculoEnUso('dl5'),
      ]);
      const repoFake = crearRepoFake([
        {
          ...tareaLicenciaVencida,
          deliveryId: 'dl5',
          status: MaintenanceTaskStatus.DONE,
        } as MaintenanceTask,
      ]);
      service = new FleetDispatchLockService(
        repoFake as unknown as Repository<MaintenanceTask>,
        vehicleAssignments as unknown as VehicleAssignmentService,
        deliveryService as unknown as DeliveryService,
        employees as unknown as EmployeeService,
        leaves as unknown as LeaveService,
      );

      const inhabilitados = await service.choferesInhabilitados(
        ['user-5'],
        'd1',
      );

      expect(inhabilitados.has('user-5')).toBe(false);
    });

    /**
     * Control de mutación (revisión cruzada, punto 2): con el repo FAKE,
     * esto falla de verdad si se borra el filtro de distribuidora de
     * `tareasAbiertasDe` — una tarea de OTRA distribuidora (que en la base
     * real no podría compartir `delivery_id` con ésta, pero el fake lo
     * permite para aislar el filtro) dejaría de descartarse.
     */
    it('una tarea abierta de OTRA distribuidora no inhabilita', async () => {
      deliveryService.findDeliveryIdsByUserIds.mockResolvedValue([
        { userId: 'user-6', deliveryId: 'dl6' },
      ]);
      vehicleAssignments.findVehiculosEnUsoPorDeliveryIds.mockResolvedValue([
        vehiculoEnUso('dl6'),
      ]);
      const repoFake = crearRepoFake([
        {
          ...tareaLicenciaVencida,
          deliveryId: 'dl6',
          distributorId: 'OTRA-DISTRIBUIDORA',
        } as MaintenanceTask,
      ]);
      service = new FleetDispatchLockService(
        repoFake as unknown as Repository<MaintenanceTask>,
        vehicleAssignments as unknown as VehicleAssignmentService,
        deliveryService as unknown as DeliveryService,
        employees as unknown as EmployeeService,
        leaves as unknown as LeaveService,
      );

      const inhabilitados = await service.choferesInhabilitados(
        ['user-6'],
        'd1',
      );

      expect(inhabilitados.has('user-6')).toBe(false);
    });
  });

  describe('motivosDeInhabilitacion', () => {
    it('describe en castellano qué venció, con la fecha en UTC (sin desfasaje de huso) y sin adjetivo con género', async () => {
      deliveryService.findDeliveryIdsByUserIds.mockResolvedValue([
        { userId: 'user-1', deliveryId: 'dl1' },
      ]);
      vehicleAssignments.findVehiculosEnUsoPorDeliveryIds.mockResolvedValue([
        vehiculoEnUso('dl1'),
      ]);
      tasks.find.mockResolvedValue([tareaLicenciaVencida]); // dueAt: 2020-01-01T00:00:00.000Z

      const motivos = await service.motivosDeInhabilitacion('user-1', 'd1');

      expect(motivos).toEqual(['Licencia de conducir: venció el 01/01/2020']);
    });

    it('sin vehículo en uso, el motivo lo dice', async () => {
      deliveryService.findDeliveryIdsByUserIds.mockResolvedValue([
        { userId: 'user-0', deliveryId: 'dl0' },
      ]);

      const motivos = await service.motivosDeInhabilitacion('user-0', 'd1');

      expect(motivos).toEqual(['no tiene un vehículo asignado']);
    });

    it('un chofer en condiciones (con vehículo y sin tareas vencidas) no tiene motivos', async () => {
      deliveryService.findDeliveryIdsByUserIds.mockResolvedValue([
        { userId: 'user-7', deliveryId: 'dl7' },
      ]);
      vehicleAssignments.findVehiculosEnUsoPorDeliveryIds.mockResolvedValue([
        vehiculoEnUso('dl7'),
      ]);
      tasks.find.mockResolvedValue([]);

      const motivos = await service.motivosDeInhabilitacion('user-7', 'd1');
      expect(motivos).toEqual([]);
    });
  });

  describe('assertChoferHabilitado', () => {
    it('rechaza con un 400 en castellano que dice qué está vencido, si hay algo inhabilitante', async () => {
      deliveryService.findDeliveryIdsByUserIds.mockResolvedValue([
        { userId: 'user-1', deliveryId: 'dl1' },
      ]);
      vehicleAssignments.findVehiculosEnUsoPorDeliveryIds.mockResolvedValue([
        vehiculoEnUso('dl1'),
      ]);
      tasks.find.mockResolvedValue([tareaLicenciaVencida]);

      await expect(
        service.assertChoferHabilitado('user-1', 'd1'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.assertChoferHabilitado('user-1', 'd1'),
      ).rejects.toThrow(
        'No se puede asignar: Licencia de conducir: venció el 01/01/2020.',
      );
    });

    it('rechaza con un 400 en castellano si no tiene vehículo asignado', async () => {
      deliveryService.findDeliveryIdsByUserIds.mockResolvedValue([
        { userId: 'user-0', deliveryId: 'dl0' },
      ]);

      await expect(
        service.assertChoferHabilitado('user-0', 'd1'),
      ).rejects.toThrow('No se puede asignar: no tiene un vehículo asignado.');
    });

    it('no hace nada si el chofer está en condiciones', async () => {
      deliveryService.findDeliveryIdsByUserIds.mockResolvedValue([
        { userId: 'user-8', deliveryId: 'dl8' },
      ]);
      vehicleAssignments.findVehiculosEnUsoPorDeliveryIds.mockResolvedValue([
        vehiculoEnUso('dl8'),
      ]);
      tasks.find.mockResolvedValue([]);

      await expect(
        service.assertChoferHabilitado('user-8', 'd1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('vehiculoEnUsoDelChofer', () => {
    it('devuelve el snapshot del vehículo en uso', async () => {
      deliveryService.findDeliveryIdsByUserIds.mockResolvedValue([
        { userId: 'user-9', deliveryId: 'dl9' },
      ]);
      vehicleAssignments.findVehiculosEnUsoPorDeliveryIds.mockResolvedValue([
        vehiculoEnUso('dl9', 'c9'),
      ]);

      const vehiculo = await service.vehiculoEnUsoDelChofer('user-9', 'd1');

      expect(vehiculo).toEqual({
        carId: 'c9',
        patent: 'AB123CD',
        brand: 'Honda',
        model: 'Wave',
      });
    });

    it('null si el chofer no tiene vehículo en uso', async () => {
      deliveryService.findDeliveryIdsByUserIds.mockResolvedValue([
        { userId: 'user-10', deliveryId: 'dl10' },
      ]);

      const vehiculo = await service.vehiculoEnUsoDelChofer('user-10', 'd1');
      expect(vehiculo).toBeNull();
    });

    it('null si el user_id no resuelve a ningún chofer', async () => {
      const vehiculo = await service.vehiculoEnUsoDelChofer('ghost', 'd1');
      expect(vehiculo).toBeNull();
    });
  });

  describe('habilitación laboral (CU-246)', () => {
    const planCurso: MaintenancePlan = {
      ...planVehiculo,
      planId: 'plan-curso',
      name: 'Examen psicofísico',
      subject: MaintenanceSubject.EMPLOYEE,
    };
    const tareaDelLegajoVencida = {
      taskId: 't-psico',
      carId: null,
      deliveryId: null,
      employeeId: 'e1',
      distributorId: 'd1',
      status: MaintenanceTaskStatus.SCHEDULED,
      dueAt: new Date('2020-03-01T00:00:00.000Z'),
      plan: planCurso,
    } as unknown as MaintenanceTask;

    const legajo = (over: Record<string, unknown> = {}) => ({
      employeeId: 'e1',
      userId: 'user-1',
      status: EmployeeStatus.ACTIVE,
      ...over,
    });

    function chofer(userId = 'user-1', deliveryId = 'dl1') {
      deliveryService.findDeliveryIdsByUserIds.mockResolvedValue([
        { userId, deliveryId },
      ]);
      vehicleAssignments.findVehiculosEnUsoPorDeliveryIds.mockResolvedValue([
        vehiculoEnUso(deliveryId),
      ]);
    }

    it('un chofer sin legajo conserva el comportamiento anterior (habilitado)', async () => {
      chofer();

      const inhabilitados = await service.choferesInhabilitados(
        ['user-1'],
        'd1',
      );

      expect(inhabilitados.size).toBe(0);
      expect(leaves.empleadosDeLicenciaEn).toHaveBeenCalledWith(
        [],
        expect.any(String),
      );
    });

    it('un chofer con el psicofísico de su legajo vencido queda inhabilitado, y el motivo lo dice', async () => {
      chofer();
      employees.findByUserIds.mockResolvedValue([legajo()]);
      const repo = crearRepoFake([tareaDelLegajoVencida]);
      Object.assign(tasks, repo);

      expect(
        (await service.choferesInhabilitados(['user-1'], 'd1')).has('user-1'),
      ).toBe(true);
      await expect(
        service.motivosDeInhabilitacion('user-1', 'd1'),
      ).resolves.toEqual(['Examen psicofísico: venció el 01/03/2020']);
    });

    it('lo bloqueante vencido de OTRO legajo no inhabilita a este chofer', async () => {
      chofer();
      employees.findByUserIds.mockResolvedValue([legajo()]);
      Object.assign(
        tasks,
        crearRepoFake([
          { ...tareaDelLegajoVencida, employeeId: 'otro' } as MaintenanceTask,
        ]),
      );

      expect((await service.choferesInhabilitados(['user-1'], 'd1')).size).toBe(
        0,
      );
    });

    it('una tarea del legajo no bloqueante (la ART) vencida no inhabilita', async () => {
      chofer();
      employees.findByUserIds.mockResolvedValue([legajo()]);
      Object.assign(
        tasks,
        crearRepoFake([
          {
            ...tareaDelLegajoVencida,
            plan: {
              ...planCurso,
              criticality: MaintenanceCriticality.NON_BLOCKING,
            },
          } as MaintenanceTask,
        ]),
      );

      expect((await service.choferesInhabilitados(['user-1'], 'd1')).size).toBe(
        0,
      );
    });

    it('un legajo egresado inhabilita al chofer', async () => {
      chofer();
      employees.findByUserIds.mockResolvedValue([
        legajo({ status: EmployeeStatus.TERMINATED }),
      ]);

      expect(
        (await service.choferesInhabilitados(['user-1'], 'd1')).has('user-1'),
      ).toBe(true);
      await expect(
        service.motivosDeInhabilitacion('user-1', 'd1'),
      ).resolves.toEqual(['su legajo está egresado']);
    });

    it('una licencia aprobada que cubre hoy inhabilita al chofer', async () => {
      chofer();
      employees.findByUserIds.mockResolvedValue([legajo()]);
      leaves.empleadosDeLicenciaEn.mockResolvedValue(new Set(['e1']));

      await expect(
        service.motivosDeInhabilitacion('user-1', 'd1'),
      ).resolves.toEqual([
        'tiene una licencia aprobada que cubre el día de hoy',
      ]);
      await expect(
        service.assertChoferHabilitado('user-1', 'd1'),
      ).rejects.toThrow(
        'No se puede asignar: tiene una licencia aprobada que cubre el día de hoy.',
      );
    });

    it('pregunta por las licencias de todos los legajos en una sola consulta', async () => {
      deliveryService.findDeliveryIdsByUserIds.mockResolvedValue([
        { userId: 'user-1', deliveryId: 'dl1' },
        { userId: 'user-2', deliveryId: 'dl2' },
      ]);
      vehicleAssignments.findVehiculosEnUsoPorDeliveryIds.mockResolvedValue([
        vehiculoEnUso('dl1', 'c1'),
        vehiculoEnUso('dl2', 'c2'),
      ]);
      employees.findByUserIds.mockResolvedValue([
        legajo(),
        legajo({ employeeId: 'e2', userId: 'user-2' }),
      ]);
      leaves.empleadosDeLicenciaEn.mockResolvedValue(new Set(['e2']));

      const inhabilitados = await service.choferesInhabilitados(
        ['user-1', 'user-2'],
        'd1',
      );

      expect([...inhabilitados]).toEqual(['user-2']);
      expect(leaves.empleadosDeLicenciaEn).toHaveBeenCalledTimes(1);
      expect(employees.findByUserIds).toHaveBeenCalledTimes(1);
    });
  });
});
