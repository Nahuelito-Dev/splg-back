import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { TerminateEmployeeUseCase } from './terminate-employee.use-case';
import { EmployeeService } from '../employee.service';
import { EmployeeRulesRegistry } from '../employee-rules.registry';
import {
  Employee,
  EmployeeStatus,
  EmployeeTerminationReason,
} from '../entities/employee.entity';
import { DeliveryService } from '../../delivery/delivery.service';
import { UsersService } from '../../users/users.service';
import { VehicleAssignmentService } from '../../car/vehicle-assignment.service';
import { OrderLookupService } from '../../order/lookup/order-lookup.service';

describe('TerminateEmployeeUseCase', () => {
  const dto = {
    terminationDate: '2026-10-04',
    reason: EmployeeTerminationReason.RESIGNATION,
  };
  let guardado: Employee[];
  let manager: EntityManager;
  let employees: {
    findOne: jest.Mock;
    bloquear: jest.Mock;
    findOneDetallado: jest.Mock;
  };
  let users: {
    bloquearEnTransaccion: jest.Mock;
    avisarAccesoRevocado: jest.Mock;
  };
  let deliveries: {
    findByUserIdEnTransaccion: jest.Mock;
    deshabilitarEnTransaccion: jest.Mock;
    quitarDelRadar: jest.Mock;
  };
  let vehicles: { liberarSiTieneUno: jest.Mock };
  let orders: { countActiveByDelivery: jest.Mock };
  let rules: EmployeeRulesRegistry;
  let useCase: TerminateEmployeeUseCase;

  const empleado = (over: Partial<Employee> = {}): Employee =>
    ({
      employeeId: 'e1',
      distributorId: 'd1',
      userId: 'u1',
      status: EmployeeStatus.ACTIVE,
      hireDate: '2026-03-01',
      terminationDate: null,
      terminationReason: null,
      ...over,
    }) as Employee;

  beforeEach(() => {
    guardado = [];
    manager = {
      query: jest.fn().mockResolvedValue([]),
      getRepository: () => ({
        save: jest.fn((e: Employee) => {
          guardado.push({ ...e });
          return Promise.resolve(e);
        }),
      }),
    } as unknown as EntityManager;
    employees = {
      findOne: jest.fn().mockResolvedValue(empleado()),
      bloquear: jest.fn().mockResolvedValue(empleado()),
      findOneDetallado: jest
        .fn()
        .mockResolvedValue({ empleado: {}, deliveryId: 'dl1' }),
    };
    users = {
      bloquearEnTransaccion: jest.fn(),
      avisarAccesoRevocado: jest.fn(),
    };
    deliveries = {
      findByUserIdEnTransaccion: jest
        .fn()
        .mockResolvedValue({ deliveryId: 'dl1', userId: 'u1' }),
      deshabilitarEnTransaccion: jest.fn(),
      quitarDelRadar: jest.fn(),
    };
    vehicles = { liberarSiTieneUno: jest.fn() };
    orders = { countActiveByDelivery: jest.fn().mockResolvedValue(0) };
    rules = new EmployeeRulesRegistry();
    const dataSource = {
      transaction: (fn: (m: EntityManager) => Promise<unknown>) => fn(manager),
    };
    useCase = new TerminateEmployeeUseCase(
      dataSource as unknown as DataSource,
      employees as unknown as EmployeeService,
      users as unknown as UsersService,
      deliveries as unknown as DeliveryService,
      vehicles as unknown as VehicleAssignmentService,
      orders as unknown as OrderLookupService,
      rules,
    );
  });

  it('un chofer: legajo egresado, usuario bloqueado, chofer deshabilitado, vehículo liberado y fuera del radar', async () => {
    await useCase.execute('e1', dto, 'd1', 'admin1');

    expect(guardado[0]).toMatchObject({
      status: EmployeeStatus.TERMINATED,
      terminationDate: '2026-10-04',
      terminationReason: EmployeeTerminationReason.RESIGNATION,
    });
    expect(users.bloquearEnTransaccion).toHaveBeenCalledWith(manager, 'u1');
    expect(deliveries.deshabilitarEnTransaccion).toHaveBeenCalledWith(
      manager,
      'dl1',
    );
    expect(vehicles.liberarSiTieneUno).toHaveBeenCalledWith('dl1', manager, {
      motivo: expect.stringContaining('egreso del legajo') as string,
      actorUserId: 'admin1',
    });
    expect(deliveries.quitarDelRadar).toHaveBeenCalledWith('u1');
    expect(users.avisarAccesoRevocado).toHaveBeenCalledWith('u1', 'bloqueo');
  });

  it('sin cuenta: sólo cambia el legajo', async () => {
    employees.findOne.mockResolvedValue(empleado({ userId: null }));
    employees.bloquear.mockResolvedValue(empleado({ userId: null }));

    await useCase.execute('e1', dto, 'd1', 'admin1');

    expect(guardado).toHaveLength(1);
    expect(users.bloquearEnTransaccion).not.toHaveBeenCalled();
    expect(users.avisarAccesoRevocado).not.toHaveBeenCalled();
    expect(deliveries.findByUserIdEnTransaccion).not.toHaveBeenCalled();
    expect(vehicles.liberarSiTieneUno).not.toHaveBeenCalled();
    expect(deliveries.quitarDelRadar).not.toHaveBeenCalled();
  });

  it('con cuenta pero sin perfil de reparto (admin): bloquea al usuario y nada más', async () => {
    deliveries.findByUserIdEnTransaccion.mockResolvedValue(null);

    await useCase.execute('e1', dto, 'd1', 'admin1');

    expect(users.bloquearEnTransaccion).toHaveBeenCalled();
    expect(deliveries.deshabilitarEnTransaccion).not.toHaveBeenCalled();
    expect(vehicles.liberarSiTieneUno).not.toHaveBeenCalled();
  });

  it('un egresado no puede egresar de nuevo (409) y no toca nada', async () => {
    employees.bloquear.mockResolvedValue(
      empleado({
        status: EmployeeStatus.TERMINATED,
        terminationDate: '2026-09-01',
      }),
    );

    await expect(
      useCase.execute('e1', dto, 'd1', 'admin1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(guardado).toHaveLength(0);
    expect(users.bloquearEnTransaccion).not.toHaveBeenCalled();
    expect(users.avisarAccesoRevocado).not.toHaveBeenCalled();
  });

  it('una fecha anterior al ingreso es 400', async () => {
    await expect(
      useCase.execute(
        'e1',
        { ...dto, terminationDate: '2026-02-01' },
        'd1',
        'admin1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(guardado).toHaveLength(0);
  });

  it('un chofer con pedidos en curso es 409 antes de modificar nada', async () => {
    orders.countActiveByDelivery.mockResolvedValue(2);

    await expect(useCase.execute('e1', dto, 'd1', 'admin1')).rejects.toThrow(
      /2 pedido/,
    );
    expect(guardado).toHaveLength(0);
    expect(users.bloquearEnTransaccion).not.toHaveBeenCalled();
    expect(deliveries.quitarDelRadar).not.toHaveBeenCalled();
  });

  it('las precondiciones registradas por otros módulos dan 409 con su detalle', async () => {
    rules.alEgresar(() =>
      Promise.resolve(['tiene una carga de camión abierta']),
    );

    await expect(useCase.execute('e1', dto, 'd1', 'admin1')).rejects.toThrow(
      /carga de camión abierta/,
    );
    expect(guardado).toHaveLength(0);
    expect(vehicles.liberarSiTieneUno).not.toHaveBeenCalled();
  });

  it('si liberar el vehículo falla, el error sube (la transacción real se revierte) y no se saca del radar', async () => {
    vehicles.liberarSiTieneUno.mockRejectedValue(new Error('falló'));

    await expect(useCase.execute('e1', dto, 'd1', 'admin1')).rejects.toThrow(
      'falló',
    );
    expect(deliveries.quitarDelRadar).not.toHaveBeenCalled();
  });
});
