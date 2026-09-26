import { ConflictException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { RoleService } from './role.service';
import { Role } from './entities/role.entity';
import { RoleType } from '../common/constants/role-type.enum';

/**
 * Los roles del sistema se buscan por su texto en el registro de usuarios: si
 * se renombran o se borran, deja de funcionar el alta. Eso es lo que protege
 * el servicio, además de traducir a 409 el borrado de un rol en uso.
 */
describe('RoleService', () => {
  let service: RoleService;
  let repo: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    preload: jest.Mock;
    remove: jest.Mock;
  };

  const rol = (type: string, role_id = 'rol-1'): Role =>
    ({ role_id, type, createdAt: null, updatedAt: null }) as Role;

  beforeEach(() => {
    repo = {
      create: jest.fn((datos: Partial<Role>) => datos),
      save: jest.fn((r: Role) => Promise.resolve(r)),
      find: jest.fn(),
      findOne: jest.fn(),
      preload: jest.fn(),
      remove: jest.fn(),
    };
    service = new RoleService(repo as unknown as Repository<Role>);
  });

  it('findOne lanza 404 si el rol no existe', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(service.findOne('no-existe')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('no deja modificar un rol del sistema', async () => {
    repo.findOne.mockResolvedValue(rol(RoleType.CUSTOMER));
    await expect(
      service.update('rol-1', { type: 'otro' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('modifica un rol propio', async () => {
    repo.findOne.mockResolvedValue(rol('qa_pruebas'));
    repo.preload.mockResolvedValue(rol('qa_renombrado'));
    const r = await service.update('rol-1', { type: 'qa_renombrado' });
    expect(r.type).toBe('qa_renombrado');
  });

  it('no deja borrar un rol del sistema', async () => {
    repo.findOne.mockResolvedValue(rol(RoleType.ADMIN));
    await expect(service.remove('rol-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repo.remove).not.toHaveBeenCalled();
  });

  it('borrar un rol con usuarios es un 409 y no un 500', async () => {
    repo.findOne.mockResolvedValue(rol('qa_pruebas'));
    repo.remove.mockRejectedValue({ code: '23503', detail: 'en uso' });
    await expect(service.remove('rol-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('borra un rol propio sin usuarios', async () => {
    repo.findOne.mockResolvedValue(rol('qa_pruebas'));
    repo.remove.mockResolvedValue(undefined);
    await expect(service.remove('rol-1')).resolves.toEqual({
      message: 'Role deleted successfully',
    });
  });

  it('la siembra crea sólo los roles que faltan', async () => {
    const existentes = new Set<string>([RoleType.CUSTOMER, RoleType.ADMIN]);
    repo.findOne.mockImplementation(({ where }: { where: { type: string } }) =>
      Promise.resolve(existentes.has(where.type) ? rol(where.type) : null),
    );
    await service.seedRoles();
    const creados = repo.create.mock.calls.map(
      ([datos]: [Partial<Role>]) => datos.type,
    );
    expect(creados.sort()).toEqual(
      Object.values(RoleType)
        .filter((t) => !existentes.has(t))
        .sort(),
    );
  });
});
