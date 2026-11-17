import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AdminService } from './admin.service';
import { AdminMapper } from './admin.mapper';
import { Admin } from './entities/admin.entity';
import { RoleType } from '../common/constants/role-type.enum';
import { UsersService } from '../users/users.service';
import { RoleService } from '../role/role.service';

/**
 * El servicio de administradores decide dos cosas que protegen al sistema: si
 * ya existe un super admin (el comando de arranque crea sólo el primero) y de
 * qué distribuidora son los admins que se listan.
 */
describe('AdminService', () => {
  let service: AdminService;
  let admins: {
    find: jest.Mock;
    count: jest.Mock;
    createQueryBuilder: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    exists: jest.Mock;
    findOne: jest.Mock;
    manager: { exists: jest.Mock };
  };
  let users: { findById: jest.Mock; update: jest.Mock; remove: jest.Mock };
  let roles: { findOne: jest.Mock };
  let qb: { leftJoinAndSelect: jest.Mock; where: jest.Mock; getOne: jest.Mock };
  let existeDistribuidora: jest.Mock;

  beforeEach(() => {
    existeDistribuidora = jest.fn().mockResolvedValue(true);
    qb = {
      leftJoinAndSelect: jest.fn(() => qb),
      where: jest.fn(() => qb),
      getOne: jest.fn(),
    };
    admins = {
      find: jest.fn(),
      count: jest.fn(),
      createQueryBuilder: jest.fn(() => qb),
      create: jest.fn((d: Partial<Admin>) => d),
      save: jest.fn((a: Admin) => Promise.resolve(a)),
      exists: jest.fn().mockResolvedValue(false),
      findOne: jest.fn(),
      manager: { exists: existeDistribuidora },
    };
    users = { findById: jest.fn(), update: jest.fn(), remove: jest.fn() };
    roles = { findOne: jest.fn() };
    service = new AdminService(
      admins as unknown as Repository<Admin>,
      users as unknown as UsersService,
      roles as unknown as RoleService,
    );
  });

  it('sabe si ya hay un super admin, por el tipo de rol', async () => {
    admins.count.mockResolvedValue(1);
    await expect(service.existeSuperAdmin()).resolves.toBe(true);
    expect(admins.count).toHaveBeenCalledWith({
      where: { user: { role: { type: RoleType.SUPER_ADMIN } } },
    });
    admins.count.mockResolvedValue(0);
    await expect(service.existeSuperAdmin()).resolves.toBe(false);
  });

  describe('emailsDeAdminsActivos', () => {
    it('acota a la distribuidora y deja afuera bloqueados, dados de baja, sin correo y otros roles', async () => {
      const q: Record<string, jest.Mock> = {};
      for (const m of [
        'innerJoinAndSelect',
        'innerJoin',
        'where',
        'andWhere',
      ]) {
        q[m] = jest.fn(() => q);
      }
      q.getMany = jest
        .fn()
        .mockResolvedValue([
          { user: { email: 'a@x.com' } },
          { user: { email: 'a@x.com' } },
          { user: { email: 'b@x.com' } },
          { user: {} },
        ]);
      admins.createQueryBuilder.mockReturnValue(q);

      const emails = await service.emailsDeAdminsActivos('d1');

      expect(emails).toEqual(['a@x.com', 'b@x.com']);
      expect(q.where).toHaveBeenCalledWith('a.distributorId = :distributorId', {
        distributorId: 'd1',
      });
      const condiciones = (q.andWhere.mock.calls as string[][]).map(
        (c) => c[0],
      );
      expect(condiciones).toEqual(
        expect.arrayContaining([
          'u.blocked = false',
          'u.deletedAt IS NULL',
          'u.email IS NOT NULL',
          'r.type = :tipo',
        ]),
      );
      expect(q.andWhere).toHaveBeenCalledWith('r.type = :tipo', {
        tipo: RoleType.ADMIN,
      });
    });
  });

  it('lista sólo los admins de la distribuidora pedida', async () => {
    admins.find.mockResolvedValue([]);
    await service.findAll('dist-1');
    expect(admins.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          distributorId: 'dist-1',
        }) as unknown,
      }),
    );
    await service.findAll(null);
    const donde = (
      admins.find.mock.calls[1] as [{ where: Record<string, unknown> }]
    )[0].where;
    expect(donde.distributorId).toBeUndefined();
  });

  it('el listado y la ficha dejan afuera a los administradores dados de baja', async () => {
    admins.find.mockResolvedValue([]);
    admins.findOne.mockResolvedValue(null);
    await service.findAll('dist-1');
    expect(
      (admins.find.mock.calls[0] as [{ where: object }])[0].where,
    ).toHaveProperty('user');
    await expect(service.findDetail('a1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(
      (admins.findOne.mock.calls[0] as [{ where: object }])[0].where,
    ).toHaveProperty('user');
  });

  it('busca por id si el término es un uuid y por correo si no', async () => {
    qb.getOne.mockResolvedValue({ adminId: 'a1' });
    await service.findAdminByTerm('0c8b00a8-7d75-4793-9362-5855689be8c6');
    expect(qb.where).toHaveBeenLastCalledWith(
      'admin.adminId = :admin_id',
      expect.anything(),
    );
    await service.findAdminByTerm('Admin@Splg.com');
    // Sin distinguir mayúsculas: compara el correo en minúsculas.
    expect(qb.where).toHaveBeenLastCalledWith('LOWER(user.email) = :email', {
      email: 'admin@splg.com',
    });
  });

  it('no le cuelga un perfil de admin a un cliente', async () => {
    users.findById.mockResolvedValue({ userId: 'u1', roleId: 'r-cliente' });
    roles.findOne.mockResolvedValue({ roleId: 'r-cliente', type: 'customer' });
    await expect(
      service.create({ user_id: 'u1', distributor_id: 'd1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(admins.save).not.toHaveBeenCalled();
  });

  it('un admin de empresa sin distribuidora es 400', async () => {
    users.findById.mockResolvedValue({ userId: 'u1', roleId: 'r-admin' });
    roles.findOne.mockResolvedValue({ roleId: 'r-admin', type: 'admin' });
    await expect(service.create({ user_id: 'u1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('el rol del perfil es el del usuario', async () => {
    users.findById.mockResolvedValue({ userId: 'u1', roleId: 'r-admin' });
    roles.findOne.mockResolvedValue({ roleId: 'r-admin', type: 'admin' });
    await service.create({ user_id: 'u1', distributor_id: 'd1' }, 'd1');
    expect(admins.save).toHaveBeenCalled();
    expect(roles.findOne).toHaveBeenCalledWith('r-admin');
  });

  it('el alta devuelve el admin releído con el rol de personal que puso la base', async () => {
    users.findById.mockResolvedValue({ userId: 'u1', roleId: 'r-admin' });
    roles.findOne.mockResolvedValue({ roleId: 'r-admin', type: 'admin' });
    admins.save.mockResolvedValue({ adminId: 'a-nuevo', userId: 'u1' });
    const releido = {
      adminId: 'a-nuevo',
      userId: 'u1',
      staffRole: { staffRoleId: 'r1', name: 'Administrador', isSystem: true },
    };
    admins.findOne.mockResolvedValue(releido);
    await expect(
      service.create({ user_id: 'u1', distributor_id: 'd1' }, 'd1'),
    ).resolves.toBe(releido);
    expect(admins.findOne).toHaveBeenCalledWith({
      where: { adminId: 'a-nuevo' },
      relations: ['staffRole'],
    });
  });

  it('alta de plataforma (sin empresa en contexto): la del cuerpo tiene que existir', async () => {
    users.findById.mockResolvedValue({ userId: 'u1', roleId: 'r-admin' });
    roles.findOne.mockResolvedValue({ roleId: 'r-admin', type: 'admin' });
    existeDistribuidora.mockResolvedValueOnce(false);
    await expect(
      service.create({ user_id: 'u1', distributor_id: 'd1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(existeDistribuidora).toHaveBeenCalledWith(expect.anything(), {
      where: { distributorId: 'd1' },
    });
    expect(admins.save).not.toHaveBeenCalled();
  });

  it('con empresa en contexto, el perfil de un admin de empresa tiene que coincidir con el cuerpo', async () => {
    users.findById.mockResolvedValue({ userId: 'u1', roleId: 'r-admin' });
    roles.findOne.mockResolvedValue({ roleId: 'r-admin', type: 'admin' });
    await expect(
      service.create({ user_id: 'u1', distributor_id: 'd1' }, 'd2'),
    ).rejects.toThrow(/no coincide/);
    expect(admins.save).not.toHaveBeenCalled();
  });

  it('con distribuidora en contexto, el admin de otra es 404', async () => {
    qb.getOne.mockResolvedValue({ adminId: 'a1', distributorId: 'd2' });
    await expect(
      service.findAdminByTerm('otro@splg.com', 'd1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('un término sin admin es 404', async () => {
    qb.getOne.mockResolvedValue(null);
    await expect(
      service.findAdminByTerm('nadie@splg.com'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('la vista del admin no expone el identificador de Firebase', () => {
    const vista = AdminMapper.toVista({
      adminId: 'a1',
      user: {
        email: 'a@splg.com',
        fullName: 'Ana',
        firebaseUid: 'secreto',
        role: { type: RoleType.ADMIN },
      },
    } as unknown as Admin);
    expect(vista).toEqual({
      admin_id: 'a1',
      email: 'a@splg.com',
      displayName: 'Ana',
      fullName: 'Ana',
      rol: RoleType.ADMIN,
    });
  });

  describe('update y remove', () => {
    const perfil = (over: Partial<Admin> = {}): Admin =>
      ({
        adminId: 'a1',
        userId: 'u1',
        distributorId: 'd1',
        user: { blocked: false },
        ...over,
      }) as unknown as Admin;

    it('update edita nombre y teléfono del usuario del perfil, acotado por distribuidora', async () => {
      admins.findOne.mockResolvedValue(perfil());
      await service.update(
        'a1',
        { fullName: 'Ana', phoneNumber: '+5493764000000' },
        'd1',
      );
      expect(users.update).toHaveBeenCalledWith(
        'u1',
        { full_name: 'Ana', phone_number: '+5493764000000' },
        undefined,
      );
      expect(
        (admins.findOne.mock.calls[0] as [{ where: object }])[0].where,
      ).toMatchObject({ adminId: 'a1', distributorId: 'd1' });
    });

    it('update de un admin inexistente o de otra empresa es 404 y no toca al usuario', async () => {
      admins.findOne.mockResolvedValue(null);
      await expect(
        service.update('a1', { fullName: 'Ana' }, 'd1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(users.update).not.toHaveBeenCalled();
    });

    it('baja: es la baja del usuario del perfil (con su regla del último admin)', async () => {
      admins.findOne.mockResolvedValue(perfil());
      users.remove.mockResolvedValue({ message: 'ok' });
      await expect(service.remove('a1', 'd1')).resolves.toEqual({
        message: 'ok',
      });
      expect(users.remove).toHaveBeenCalledWith('u1', {
        autorizar: undefined,
      });
    });

    it('baja de un admin inexistente o de otra empresa: 404 y no toca al usuario', async () => {
      admins.findOne.mockResolvedValue(null);
      await expect(service.remove('a1', 'd1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(users.remove).not.toHaveBeenCalled();
    });
  });
});
