import type { DataSource, EntityManager } from 'typeorm';
import { StaffPermissionsService } from './staff-permissions.service';
import { RoleType } from '../common/constants/role-type.enum';
import { PERMISOS } from '../common/permisos/catalogo';

interface Fila {
  staff_role_id: string;
  name: string;
  is_system: boolean;
  permissions: string[];
}

const fila = (parcial: Partial<Fila>): Fila => ({
  staff_role_id: 'r-1',
  name: 'Depósito',
  is_system: false,
  permissions: [],
  ...parcial,
});

describe('StaffPermissionsService', () => {
  let query: jest.Mock<Promise<Fila[]>, [string, unknown[]]>;
  let service: StaffPermissionsService;

  beforeEach(() => {
    query = jest.fn<Promise<Fila[]>, [string, unknown[]]>();
    service = new StaffPermissionsService({
      manager: { query },
    } as unknown as DataSource);
  });

  it('el super admin tiene todos, sin ir a la base', async () => {
    await expect(service.deUsuario('s', RoleType.SUPER_ADMIN)).resolves.toEqual(
      { todos: true, rol: null, permisos: [...PERMISOS] },
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('el super admin dentro de la empresa propia: admin con todos, sin ir a la base', async () => {
    await expect(
      service.deUsuario('s', RoleType.ADMIN, undefined, true),
    ).resolves.toEqual({ todos: true, rol: null, permisos: [...PERMISOS] });
    expect(query).not.toHaveBeenCalled();
  });

  it('una cuenta de las apps no tiene permisos de personal', async () => {
    await expect(
      service.deUsuario('c', RoleType.CUSTOMER),
    ).resolves.toMatchObject({ todos: false, permisos: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it('una sola consulta por usuario, de admin a su rol vigente', async () => {
    query.mockResolvedValue([fila({ permissions: ['pedidos.ver'] })]);
    await service.deUsuario('u-1', RoleType.ADMIN);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/FROM "admin" a\s+JOIN "staff_role" sr/);
    expect(sql).toContain('sr."deletedAt" IS NULL');
    expect(params).toEqual(['u-1']);
  });

  it('el rol de sistema tiene todo el catálogo', async () => {
    query.mockResolvedValue([fila({ is_system: true, name: 'Administrador' })]);
    await expect(service.deUsuario('u-1', RoleType.ADMIN)).resolves.toEqual({
      todos: true,
      rol: { staffRoleId: 'r-1', name: 'Administrador', isSystem: true },
      permisos: [...PERMISOS],
    });
  });

  it('un rol propio: sus permisos con el ver de cada gestionar, sin lo que salió del catálogo', async () => {
    query.mockResolvedValue([
      fila({ permissions: ['stock.gestionar', 'viejo.permiso'] }),
    ]);
    await expect(
      service.deUsuario('u-1', RoleType.ADMIN),
    ).resolves.toMatchObject({
      todos: false,
      permisos: ['stock.ver', 'stock.gestionar'],
    });
  });

  it('sin rol vigente (o con el rol dado de baja) no tiene permisos', async () => {
    query.mockResolvedValue([]);
    await expect(service.deUsuario('u-1', RoleType.ADMIN)).resolves.toEqual({
      todos: false,
      rol: null,
      permisos: [],
    });
  });

  it('no guarda nada entre llamadas: un permiso revocado vale en la siguiente', async () => {
    query.mockResolvedValueOnce([fila({ permissions: ['roles.gestionar'] })]);
    query.mockResolvedValueOnce([fila({ permissions: ['pedidos.ver'] })]);
    await expect(
      service.deUsuario('u-1', RoleType.ADMIN),
    ).resolves.toMatchObject({ permisos: ['roles.gestionar'] });
    await expect(
      service.deUsuario('u-1', RoleType.ADMIN),
    ).resolves.toMatchObject({ permisos: ['pedidos.ver'] });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('con manager lee dentro de esa transacción', async () => {
    const otra = jest.fn().mockResolvedValue([]);
    await service.deUsuario('u-1', RoleType.ADMIN, {
      query: otra,
    } as unknown as EntityManager);
    expect(otra).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });
});
