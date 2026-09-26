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
  };
  let users: { findById: jest.Mock };
  let roles: { findOne: jest.Mock };
  let qb: { leftJoinAndSelect: jest.Mock; where: jest.Mock; getOne: jest.Mock };

  beforeEach(() => {
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
    };
    users = { findById: jest.fn() };
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

  it('lista sólo los admins de la distribuidora pedida', async () => {
    admins.find.mockResolvedValue([]);
    await service.findAll('dist-1');
    expect(admins.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { distributor_id: 'dist-1' } }),
    );
    await service.findAll(null);
    expect(admins.find).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });

  it('busca por id si el término es un uuid y por correo si no', async () => {
    qb.getOne.mockResolvedValue({ admin_id: 'a1' });
    await service.findAdminByTerm('0c8b00a8-7d75-4793-9362-5855689be8c6');
    expect(qb.where).toHaveBeenLastCalledWith(
      'admin.admin_id = :admin_id',
      expect.anything(),
    );
    await service.findAdminByTerm('admin@splg.com');
    expect(qb.where).toHaveBeenLastCalledWith(
      'user.email = :email',
      expect.anything(),
    );
  });

  it('no le cuelga un perfil de admin a un cliente', async () => {
    users.findById.mockResolvedValue({ user_id: 'u1', role_id: 'r-cliente' });
    roles.findOne.mockResolvedValue({ role_id: 'r-cliente', type: 'customer' });
    await expect(
      service.create({ user_id: 'u1', distributor_id: 'd1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(admins.save).not.toHaveBeenCalled();
  });

  it('un admin de empresa sin distribuidora es 400', async () => {
    users.findById.mockResolvedValue({ user_id: 'u1', role_id: 'r-admin' });
    roles.findOne.mockResolvedValue({ role_id: 'r-admin', type: 'admin' });
    await expect(service.create({ user_id: 'u1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('el rol del perfil es el del usuario', async () => {
    users.findById.mockResolvedValue({ user_id: 'u1', role_id: 'r-admin' });
    roles.findOne.mockResolvedValue({ role_id: 'r-admin', type: 'admin' });
    await service.create({ user_id: 'u1', distributor_id: 'd1' });
    expect(admins.save).toHaveBeenCalled();
    expect(roles.findOne).toHaveBeenCalledWith('r-admin');
  });

  it('con distribuidora en contexto, el admin de otra es 404', async () => {
    qb.getOne.mockResolvedValue({ admin_id: 'a1', distributor_id: 'd2' });
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
      admin_id: 'a1',
      user: {
        email: 'a@splg.com',
        full_name: 'Ana',
        firebase_uid: 'secreto',
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
});
