import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RegistroService } from './registro.service';
import { RegistrarUsuarioDto } from './dto/registrar-usuario.dto';
import { FirebaseAuthPort } from '../firebase/ports/firebase-auth.port';
import { UsersService } from '../users/users.service';
import { RoleService } from '../role/role.service';
import { CustomersService } from '../customer/customer.service';
import { DeliveryService } from '../delivery/delivery.service';
import { AdminService } from '../admin/admin.service';
import { StaffRoleService } from '../admin/staff-role.service';
import { EmployeeService } from '../employee/employee.service';
import { ConsumptionService } from '../repurchase/consumption.service';
import { DistributorService } from '../distributor/distributor.service';
import { RoleType } from '../common/constants/role-type.enum';
import type { Solicitante } from './politica-de-registro';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { EVENTO_USUARIO_REGISTRADO } from './events/usuario-registrado.event';

/**
 * El alta es atómica: usuario y perfil en una transacción, y si algo falla se
 * compensa SÓLO la cuenta de Firebase que creó esta llamada (H-70).
 */
describe('RegistroService', () => {
  const alta = (
    over: Partial<RegistrarUsuarioDto> = {},
  ): RegistrarUsuarioDto => ({
    email: 'ana@correo.com',
    password: 'Test1234',
    full_name: 'Ana',
    phone_number: '+5493764000000',
    rol: RoleType.CUSTOMER,
    ...over,
  });
  const manager = {} as EntityManager;

  let firebase: { createUserSafe: jest.Mock; deleteUserSafe: jest.Mock };
  let users: {
    assertDisponible: jest.Mock;
    crearEnTransaccion: jest.Mock;
    findOne: jest.Mock;
  };
  let roles: { findByType: jest.Mock };
  let customers: {
    crearPerfil: jest.Mock;
    vincularConDistribuidora: jest.Mock;
  };
  let deliveries: { crearPerfil: jest.Mock };
  let admins: { crearPerfil: jest.Mock };
  let staffRoles: {
    rolParaElAlta: jest.Mock;
    confirmarRolDelAlta: jest.Mock;
    assertPuedeDarDeAlta: jest.Mock;
  };
  let distributors: { assertActive: jest.Mock };
  let employees: { crearParaUsuario: jest.Mock; vincularUsuario: jest.Mock };
  let eventos: { emit: jest.Mock };
  let consumption: { calcularDeclaracion: jest.Mock };
  let service: RegistroService;

  beforeEach(() => {
    firebase = {
      createUserSafe: jest.fn().mockResolvedValue({ uid: 'uid-nuevo' }),
      deleteUserSafe: jest.fn(),
    };
    users = {
      assertDisponible: jest.fn(),
      crearEnTransaccion: jest.fn().mockResolvedValue({ userId: 'u1' }),
      findOne: jest.fn().mockResolvedValue({ userId: 'u1' }),
    };
    roles = {
      findByType: jest.fn((type: string) =>
        Promise.resolve({ roleId: `rol-${type}`, type }),
      ),
    };
    customers = {
      crearPerfil: jest.fn(),
      vincularConDistribuidora: jest.fn(),
    };
    deliveries = { crearPerfil: jest.fn() };
    admins = { crearPerfil: jest.fn() };
    staffRoles = {
      rolParaElAlta: jest.fn(() => Promise.resolve('r-9')),
      confirmarRolDelAlta: jest.fn(() => Promise.resolve()),
      assertPuedeDarDeAlta: jest.fn(() => Promise.resolve()),
    };
    distributors = { assertActive: jest.fn() };
    employees = { crearParaUsuario: jest.fn(), vincularUsuario: jest.fn() };
    eventos = { emit: jest.fn() };
    consumption = { calcularDeclaracion: jest.fn() };
    const dataSource = {
      transaction: (fn: (m: EntityManager) => Promise<unknown>) => fn(manager),
    };
    service = new RegistroService(
      dataSource as unknown as DataSource,
      firebase as unknown as FirebaseAuthPort,
      users as unknown as UsersService,
      roles as unknown as RoleService,
      customers as unknown as CustomersService,
      deliveries as unknown as DeliveryService,
      admins as unknown as AdminService,
      staffRoles as unknown as StaffRoleService,
      distributors as unknown as DistributorService,
      employees as unknown as EmployeeService,
      eventos as unknown as EventEmitter2,
      consumption as unknown as ConsumptionService,
    );
  });

  it('un cliente: cuenta, usuario con su rol, perfil de cliente y evento', async () => {
    await service.registrar(alta(), { tipo: 'anonimo' });

    expect(users.crearEnTransaccion).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        firebaseUid: 'uid-nuevo',
        roleId: 'rol-customer',
      }),
    );
    expect(customers.crearPerfil).toHaveBeenCalledWith(
      manager,
      'u1',
      expect.any(Object),
    );
    expect(eventos.emit).toHaveBeenCalledWith(
      EVENTO_USUARIO_REGISTRADO,
      expect.objectContaining({ userId: 'u1', rol: RoleType.CUSTOMER }),
    );
  });

  describe('vínculo del cliente con la distribuidora que lo da de alta', () => {
    const adminDe = (distributor_id: string | null): Solicitante => ({
      tipo: 'usuario',
      usuario: {
        user_id: 'admin-1',
        role: RoleType.ADMIN,
        distributor_id,
      } as AuthenticatedUser,
    });
    const superAdmin: Solicitante = {
      tipo: 'usuario',
      usuario: {
        user_id: 'sa-1',
        role: RoleType.SUPER_ADMIN,
      } as AuthenticatedUser,
    };

    it('un admin vincula al cliente con su distribuidora, en la misma transacción', async () => {
      await service.registrar(alta(), adminDe('d1'), 'd1');
      expect(customers.vincularConDistribuidora).toHaveBeenCalledWith(
        manager,
        'u1',
        'd1',
        'admin-1',
      );
    });

    it('el contexto de un admin no pisa su distribuidora', async () => {
      await service.registrar(alta(), adminDe('d1'), 'otra');
      expect(customers.vincularConDistribuidora).toHaveBeenCalledWith(
        manager,
        'u1',
        'd1',
        'admin-1',
      );
    });

    it('un super admin vincula con la del cuerpo o, si no, la de X-Distributor', async () => {
      await service.registrar(alta({ distributorId: 'd2' }), superAdmin, 'd3');
      expect(customers.vincularConDistribuidora).toHaveBeenLastCalledWith(
        manager,
        'u1',
        'd2',
        'sa-1',
      );
      await service.registrar(alta(), superAdmin, 'd3');
      expect(customers.vincularConDistribuidora).toHaveBeenLastCalledWith(
        manager,
        'u1',
        'd3',
        'sa-1',
      );
      expect(distributors.assertActive).toHaveBeenCalledWith('d3');
    });

    it('un super admin sin distribuidora en contexto no vincula', async () => {
      await service.registrar(alta(), superAdmin, null);
      expect(customers.vincularConDistribuidora).not.toHaveBeenCalled();
    });

    it('el registro público y el de otros roles no vinculan', async () => {
      await service.registrar(alta(), { tipo: 'anonimo' });
      await service.registrar(
        alta({ rol: RoleType.DELIVERY }),
        adminDe('d1'),
        'd1',
      );
      expect(customers.vincularConDistribuidora).not.toHaveBeenCalled();
    });

    it('si el vínculo falla, se borra la cuenta de Firebase', async () => {
      customers.vincularConDistribuidora.mockRejectedValue(new Error('x'));
      await expect(
        service.registrar(alta(), adminDe('d1'), 'd1'),
      ).rejects.toThrow();
      expect(firebase.deleteUserSafe).toHaveBeenCalled();
    });
  });

  it('un chofer va al perfil de chofer con la distribuidora autorizada', async () => {
    await service
      .registrar(alta({ rol: RoleType.DELIVERY }), {
        tipo: 'sistema',
      })
      .catch(() => undefined);
    expect(deliveries.crearPerfil).not.toHaveBeenCalled();

    await service.registrar(
      alta({ rol: RoleType.DELIVERY, distributorId: 'd1' }),
      { tipo: 'sistema' },
    );
    expect(distributors.assertActive).toHaveBeenCalledWith('d1');
    expect(deliveries.crearPerfil).toHaveBeenCalledWith(
      manager,
      'u1',
      'd1',
      expect.any(Object),
    );
  });

  describe('alta de un admin de distribuidora: el rol del personal', () => {
    const adminActor: Solicitante = {
      tipo: 'usuario',
      usuario: {
        user_id: 'admin-1',
        role: RoleType.ADMIN,
        distributor_id: 'd1',
      } as AuthenticatedUser,
    };

    it('lo decide el servicio de roles con lo que trae el alta y va al perfil', async () => {
      await service.registrar(
        alta({ rol: RoleType.ADMIN, staffRoleId: 'r-2' }),
        adminActor,
      );
      expect(staffRoles.rolParaElAlta).toHaveBeenCalledWith(
        adminActor.tipo === 'usuario' ? adminActor.usuario : null,
        'd1',
        'r-2',
      );
      expect(admins.crearPerfil).toHaveBeenCalledWith(
        manager,
        'u1',
        'd1',
        'r-9',
      );
    });

    it('si el actor no puede dar ese rol (o no puede dar altas de admins), no se crea la cuenta', async () => {
      staffRoles.rolParaElAlta.mockRejectedValue(new ForbiddenException());
      await expect(
        service.registrar(alta({ rol: RoleType.ADMIN }), adminActor),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(firebase.createUserSafe).not.toHaveBeenCalled();
      expect(admins.crearPerfil).not.toHaveBeenCalled();
    });

    it('un cliente o un chofer piden el permiso de ese alta (si falta, no se crea la cuenta)', async () => {
      staffRoles.assertPuedeDarDeAlta.mockRejectedValue(
        new ForbiddenException(),
      );
      await expect(
        service.registrar(alta({ rol: RoleType.DELIVERY }), adminActor),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(staffRoles.assertPuedeDarDeAlta).toHaveBeenCalledWith(
        adminActor.tipo === 'usuario' ? adminActor.usuario : null,
        RoleType.DELIVERY,
      );
      expect(firebase.createUserSafe).not.toHaveBeenCalled();
    });

    it('un rol del personal para algo que no es admin es 400 STAFF_ROLE_ONLY_FOR_ADMINS', async () => {
      const error: unknown = await service
        .registrar(
          alta({ rol: RoleType.DELIVERY, staffRoleId: 'r-2' }),
          adminActor,
        )
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'STAFF_ROLE_ONLY_FOR_ADMINS',
      });
      expect(firebase.createUserSafe).not.toHaveBeenCalled();
    });

    it('el rol se vuelve a decidir dentro de la transacción, antes de escribir nada', async () => {
      const orden: string[] = [];
      staffRoles.confirmarRolDelAlta.mockImplementation(() => {
        orden.push('confirmar');
        return Promise.resolve();
      });
      users.crearEnTransaccion.mockImplementation(() => {
        orden.push('usuario');
        return Promise.resolve({ userId: 'u1' });
      });
      await service.registrar(
        alta({ rol: RoleType.ADMIN, staffRoleId: 'r-2' }),
        adminActor,
      );
      expect(staffRoles.confirmarRolDelAlta).toHaveBeenCalledWith(
        manager,
        adminActor.tipo === 'usuario' ? adminActor.usuario : null,
        'd1',
        'r-9',
      );
      expect(orden).toEqual(['confirmar', 'usuario']);
    });

    it('carrera: si en la transacción el actor ya no puede dar el rol, se revierte y se borra la cuenta de Firebase', async () => {
      staffRoles.confirmarRolDelAlta.mockRejectedValue(
        new ForbiddenException(),
      );
      await expect(
        service.registrar(
          alta({ rol: RoleType.ADMIN, staffRoleId: 'r-2' }),
          adminActor,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(users.crearEnTransaccion).not.toHaveBeenCalled();
      expect(admins.crearPerfil).not.toHaveBeenCalled();
      expect(firebase.deleteUserSafe).toHaveBeenCalledWith(
        'uid-nuevo',
        expect.anything(),
      );
      expect(eventos.emit).not.toHaveBeenCalled();
    });

    it('un cliente o un chofer no pasan por la re-validación del rol', async () => {
      await service.registrar(alta({ rol: RoleType.DELIVERY }), adminActor);
      expect(staffRoles.confirmarRolDelAlta).not.toHaveBeenCalled();
    });
  });

  it('un super admin va al perfil de admin sin distribuidora', async () => {
    await service.registrar(alta({ rol: RoleType.SUPER_ADMIN }), {
      tipo: 'sistema',
    });
    expect(admins.crearPerfil).toHaveBeenCalledWith(manager, 'u1', null);
  });

  it('con el correo o el teléfono en uso no crea nada en Firebase', async () => {
    users.assertDisponible.mockRejectedValue(new ConflictException());

    await expect(
      service.registrar(alta(), { tipo: 'anonimo' }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(firebase.createUserSafe).not.toHaveBeenCalled();
    expect(firebase.deleteUserSafe).not.toHaveBeenCalled();
  });

  it('si Firebase no crea la cuenta (ya existía allá), no borra nada', async () => {
    firebase.createUserSafe.mockRejectedValue(
      new Error('email-already-exists'),
    );

    await expect(
      service.registrar(alta(), { tipo: 'anonimo' }),
    ).rejects.toThrow();

    expect(firebase.deleteUserSafe).not.toHaveBeenCalled();
    expect(users.crearEnTransaccion).not.toHaveBeenCalled();
  });

  it('si falla el perfil, borra la cuenta que creó, por su uid, y no avisa', async () => {
    customers.crearPerfil.mockRejectedValue(new Error('se cayó la base'));

    await expect(
      service.registrar(alta(), { tipo: 'anonimo' }),
    ).rejects.toThrow();

    expect(firebase.deleteUserSafe).toHaveBeenCalledWith(
      'uid-nuevo',
      expect.anything(),
    );
    expect(eventos.emit).not.toHaveBeenCalled();
  });

  it('la política corre antes que todo: un anónimo no crea un admin', async () => {
    await expect(
      service.registrar(alta({ rol: RoleType.ADMIN, distributorId: 'd1' }), {
        tipo: 'anonimo',
      }),
    ).rejects.toThrow();
    expect(users.assertDisponible).not.toHaveBeenCalled();
    expect(firebase.createUserSafe).not.toHaveBeenCalled();
  });

  describe('legajo del empleado (CU-003 incluye CU-177)', () => {
    it('un chofer crea su legajo en la misma transacción, con sus datos', async () => {
      await service.registrar(
        alta({
          rol: RoleType.DELIVERY,
          distributorId: 'd1',
          full_name: 'Ana Pérez',
          legajo: { documentNumber: '30123456' },
        }),
        { tipo: 'sistema' },
      );

      expect(employees.crearParaUsuario).toHaveBeenCalledWith(manager, {
        rol: RoleType.DELIVERY,
        distributorId: 'd1',
        userId: 'u1',
        fullName: 'Ana Pérez',
        phoneNumber: '+5493764000000',
        legajo: { documentNumber: '30123456' },
      });
      expect(employees.vincularUsuario).not.toHaveBeenCalled();
    });

    it('con employeeId vincula el legajo existente en vez de crear otro', async () => {
      await service.registrar(
        alta({
          rol: RoleType.DELIVERY,
          distributorId: 'd1',
          employeeId: 'e1',
        }),
        { tipo: 'sistema' },
      );

      expect(employees.vincularUsuario).toHaveBeenCalledWith(manager, {
        employeeId: 'e1',
        userId: 'u1',
        distributorId: 'd1',
        rol: RoleType.DELIVERY,
      });
      expect(employees.crearParaUsuario).not.toHaveBeenCalled();
    });

    it('un admin de distribuidora también crea su legajo, o vincula el que trae', async () => {
      await service.registrar(
        alta({ rol: RoleType.ADMIN, distributorId: 'd1' }),
        { tipo: 'sistema' },
      );
      expect(employees.crearParaUsuario).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ rol: RoleType.ADMIN, distributorId: 'd1' }),
      );

      await service.registrar(
        alta({ rol: RoleType.ADMIN, distributorId: 'd1', employeeId: 'e2' }),
        { tipo: 'sistema' },
      );
      expect(employees.vincularUsuario).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ employeeId: 'e2', rol: RoleType.ADMIN }),
      );
    });

    it('un cliente o un super admin con employeeId o legajo es 400', async () => {
      for (const rol of [RoleType.CUSTOMER, RoleType.SUPER_ADMIN]) {
        await expect(
          service.registrar(alta({ rol, employeeId: 'e1' }), {
            tipo: 'sistema',
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
          service.registrar(alta({ rol, legajo: {} }), { tipo: 'sistema' }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(firebase.createUserSafe).not.toHaveBeenCalled();
    });

    it('employeeId y legajo juntos es un 400 antes de crear nada en Firebase', async () => {
      await expect(
        service.registrar(
          alta({
            rol: RoleType.DELIVERY,
            distributorId: 'd1',
            employeeId: 'e1',
            legajo: {},
          }),
          { tipo: 'sistema' },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(firebase.createUserSafe).not.toHaveBeenCalled();
    });

    it('si falla el legajo, el alta entera se revierte: se borra la cuenta de Firebase y no se avisa', async () => {
      employees.crearParaUsuario.mockRejectedValue(
        new ConflictException('documento repetido'),
      );

      await expect(
        service.registrar(
          alta({ rol: RoleType.DELIVERY, distributorId: 'd1' }),
          { tipo: 'sistema' },
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(firebase.deleteUserSafe).toHaveBeenCalledWith(
        'uid-nuevo',
        expect.anything(),
      );
      expect(eventos.emit).not.toHaveBeenCalled();
    });
  });

  describe('consumo declarado (CU-143)', () => {
    const declaracion = {
      cylinderTypeId: 'g1',
      quantityPerMonth: 2,
    };
    const calculado = {
      declaredCylinderTypeId: 'g1',
      avgMonthlyConsumptionKg: 20,
      nextRepurchaseEstimateAt: new Date('2026-11-15T00:00:00.000Z'),
    };

    it('un cliente que lo declara lo guarda en su ficha, en la misma transacción', async () => {
      consumption.calcularDeclaracion.mockResolvedValue(calculado);

      await service.registrar(alta({ consumption: declaracion }), {
        tipo: 'anonimo',
      });

      expect(consumption.calcularDeclaracion).toHaveBeenCalledWith(declaracion);
      expect(customers.crearPerfil).toHaveBeenCalledWith(
        manager,
        'u1',
        expect.objectContaining({ consumo: calculado }),
      );
    });

    it('si no lo declara, el registro sigue y el dato queda vacío', async () => {
      await service.registrar(alta(), { tipo: 'anonimo' });

      expect(consumption.calcularDeclaracion).not.toHaveBeenCalled();
      expect(customers.crearPerfil).toHaveBeenCalledWith(
        manager,
        'u1',
        expect.objectContaining({ consumo: undefined }),
      );
    });

    it('un consumo inválido corta el alta antes de crear la cuenta en Firebase', async () => {
      consumption.calcularDeclaracion.mockRejectedValue(
        new BadRequestException('fuera de rango'),
      );

      await expect(
        service.registrar(alta({ consumption: declaracion }), {
          tipo: 'anonimo',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(firebase.createUserSafe).not.toHaveBeenCalled();
      expect(users.crearEnTransaccion).not.toHaveBeenCalled();
    });

    it('el consumo sólo vale para clientes: en un chofer se ignora', async () => {
      await service.registrar(
        alta({
          rol: RoleType.DELIVERY,
          distributorId: 'd1',
          consumption: declaracion,
        }),
        { tipo: 'sistema' },
      );

      expect(consumption.calcularDeclaracion).not.toHaveBeenCalled();
    });
  });
});
