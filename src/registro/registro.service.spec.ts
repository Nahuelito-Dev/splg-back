import { ConflictException } from '@nestjs/common';
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
import { DistributorService } from '../distributor/distributor.service';
import { RoleType } from '../common/constants/role-type.enum';
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
  let customers: { crearPerfil: jest.Mock };
  let deliveries: { crearPerfil: jest.Mock };
  let admins: { crearPerfil: jest.Mock };
  let distributors: { assertActive: jest.Mock };
  let eventos: { emit: jest.Mock };
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
    customers = { crearPerfil: jest.fn() };
    deliveries = { crearPerfil: jest.fn() };
    admins = { crearPerfil: jest.fn() };
    distributors = { assertActive: jest.fn() };
    eventos = { emit: jest.fn() };
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
      distributors as unknown as DistributorService,
      eventos as unknown as EventEmitter2,
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
});
