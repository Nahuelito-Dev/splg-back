import type { DataSource } from 'typeorm';
import { Delivery } from '../delivery/entities/delivery.entity';
import { Employee } from '../employee/entities/employee.entity';
import { User } from '../users/entities/user.entity';
import type { EntityPhotoService } from '../s3/entity-photo.service';
import { PeoplePhotosService } from './people-photos.service';

const VENCE = new Date('2030-01-01');

describe('PeoplePhotosService', () => {
  let consultaUsuarios: {
    withDeleted: jest.Mock;
    select: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    getMany: jest.Mock;
  };
  let usuarios: { createQueryBuilder: jest.Mock; find: jest.Mock };
  let legajos: { find: jest.Mock };
  let choferes: { find: jest.Mock };
  let fotos: { firmadaDe: jest.Mock };
  let servicio: PeoplePhotosService;

  beforeEach(() => {
    consultaUsuarios = {
      withDeleted: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    usuarios = {
      createQueryBuilder: jest.fn().mockReturnValue(consultaUsuarios),
      find: jest.fn().mockResolvedValue([]),
    };
    legajos = { find: jest.fn().mockResolvedValue([]) };
    choferes = { find: jest.fn().mockResolvedValue([]) };
    fotos = {
      firmadaDe: jest
        .fn()
        .mockImplementation((key: string | null | undefined) =>
          Promise.resolve(
            key ? { url: `https://s3/${key}`, expiresAt: VENCE } : null,
          ),
        ),
    };
    const dataSource = {
      getRepository: (entidad: unknown) =>
        entidad === User
          ? usuarios
          : entidad === Employee
            ? legajos
            : entidad === Delivery
              ? choferes
              : null,
    };
    servicio = new PeoplePhotosService(
      dataSource as unknown as DataSource,
      fotos as unknown as EntityPhotoService,
    );
  });

  it('un admin de empresa acota los usuarios por su distribuidora', async () => {
    consultaUsuarios.getMany.mockResolvedValue([
      { userId: 'u1', photoKey: 'users/u1/a.png' },
    ]);
    const r = await servicio.firmar(['u1', 'u1', 'u2'], [], [], 'd1', 'yo');
    expect(consultaUsuarios.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('user.userId = :propioId OR'),
      { distributorId: 'd1', propioId: 'yo' },
    );
    expect(r.users).toEqual({
      u1: { url: 'https://s3/users/u1/a.png', expiresAt: VENCE },
      u2: null,
    });
  });

  it('un usuario de otra distribuidora o inexistente sale null, sin error', async () => {
    const r = await servicio.firmar(['ajeno'], [], [], 'd1', 'yo');
    expect(r.users).toEqual({ ajeno: null });
    expect(fotos.firmadaDe).toHaveBeenCalledWith(undefined);
  });

  it('un super admin sin distribuidora no acota', async () => {
    await servicio.firmar(['u1'], [], [], null, 'yo');
    expect(consultaUsuarios.andWhere).not.toHaveBeenCalled();
  });

  it('sin ids no consulta nada', async () => {
    const r = await servicio.firmar([], [], [], 'd1', 'yo');
    expect(r).toEqual({ users: {}, employees: {}, deliveries: {} });
    expect(usuarios.createQueryBuilder).not.toHaveBeenCalled();
    expect(legajos.find).not.toHaveBeenCalled();
  });

  it('los legajos se buscan sólo en la distribuidora y usan la foto propia si no hay cuenta', async () => {
    legajos.find.mockResolvedValue([
      { employeeId: 'e1', userId: null, photoKey: 'employees/d1/e1/a.png' },
    ]);
    const r = await servicio.firmar([], ['e1', 'e-ajeno'], [], 'd1', 'yo');
    expect(legajos.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ distributorId: 'd1' }) as unknown,
      }),
    );
    expect(r.employees).toEqual({
      e1: { url: 'https://s3/employees/d1/e1/a.png', expiresAt: VENCE },
      'e-ajeno': null,
    });
  });

  it('un legajo con cuenta muestra la foto del usuario, aunque no se haya pedido', async () => {
    legajos.find.mockResolvedValue([
      { employeeId: 'e1', userId: 'u9', photoKey: 'employees/d1/e1/vieja.png' },
    ]);
    usuarios.find.mockResolvedValue([
      { userId: 'u9', photoKey: 'users/u9/b.png' },
    ]);
    const r = await servicio.firmar([], ['e1'], [], 'd1', 'yo');
    expect(r.employees.e1?.url).toBe('https://s3/users/u9/b.png');
  });

  it('un legajo con cuenta reusa la foto del usuario ya leída en el mismo pedido', async () => {
    consultaUsuarios.getMany.mockResolvedValue([
      { userId: 'u9', photoKey: 'users/u9/b.png' },
    ]);
    legajos.find.mockResolvedValue([
      { employeeId: 'e1', userId: 'u9', photoKey: null },
    ]);
    const r = await servicio.firmar(['u9'], ['e1'], [], null, 'yo');
    expect(usuarios.find).not.toHaveBeenCalled();
    expect(r.employees.e1?.url).toBe('https://s3/users/u9/b.png');
  });

  it('un chofer se acota a la distribuidora y muestra la foto de su usuario', async () => {
    choferes.find.mockResolvedValue([{ deliveryId: 'c1', userId: 'u7' }]);
    usuarios.find.mockResolvedValue([
      { userId: 'u7', photoKey: 'users/u7/c.png' },
    ]);
    const r = await servicio.firmar([], [], ['c1', 'c-ajeno'], 'd1', 'yo');
    expect(choferes.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ distributorId: 'd1' }) as unknown,
      }),
    );
    expect(r.deliveries).toEqual({
      c1: { url: 'https://s3/users/u7/c.png', expiresAt: VENCE },
      'c-ajeno': null,
    });
  });

  it('los ids en mayúsculas se normalizan y la respuesta sale indexada en minúsculas', async () => {
    consultaUsuarios.getMany.mockResolvedValue([
      { userId: 'aa-bb', photoKey: 'users/aa-bb/a.png' },
    ]);
    const r = await servicio.firmar(['AA-BB', 'aa-bb'], [], [], 'd1', 'yo');
    expect(consultaUsuarios.where).toHaveBeenCalledWith(expect.any(String), {
      ids: ['aa-bb'],
    });
    expect(r.users).toEqual({
      'aa-bb': { url: 'https://s3/users/aa-bb/a.png', expiresAt: VENCE },
    });
  });
});
