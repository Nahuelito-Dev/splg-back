import { NotFoundException } from '@nestjs/common';
import { UsersController } from './users.controller';
import { RoleType } from '../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

/**
 * Escrituras por UUID sobre otra cuenta (`DELETE /users/:id`, `PATCH
 * /users/:id/block`, fotos): el super admin tiene que decir en qué
 * distribuidora actúa (`X-Distributor`), salvo sobre otro super admin, que no
 * es de ninguna.
 */
describe('UsersController · distribuidora en las escrituras sobre otra cuenta', () => {
  const superAdmin = {
    user_id: 'sup',
    role: RoleType.SUPER_ADMIN,
  } as AuthenticatedUser;
  const admin = { user_id: 'adm', role: RoleType.ADMIN } as AuthenticatedUser;
  let users: {
    findAlcance: jest.Mock;
    perteneceA: jest.Mock;
    remove: jest.Mock;
    toggleBlockUser: jest.Mock;
  };
  let controller: UsersController;

  const alcance = (rol: RoleType) =>
    users.findAlcance.mockResolvedValue({ rol, distributorId: null });

  beforeEach(() => {
    users = {
      findAlcance: jest.fn(),
      perteneceA: jest.fn().mockResolvedValue(true),
      remove: jest.fn().mockResolvedValue({ message: 'ok' }),
      toggleBlockUser: jest.fn().mockResolvedValue({ blocked: true }),
    };
    controller = new UsersController(
      users as never,
      {} as never,
      {
        assertPuedeAdministrarA: jest.fn().mockResolvedValue(undefined),
      } as never,
    );
  });

  it('super admin sin distribuidora da de baja a un admin de empresa', async () => {
    alcance(RoleType.ADMIN);
    await controller.remove('x', superAdmin, null);
    expect(users.remove).toHaveBeenCalledWith('x', { autorizar: undefined });
  });

  it('super admin sin distribuidora no da de baja a un chofer', async () => {
    alcance(RoleType.DELIVERY);
    await expect(
      controller.remove('x', superAdmin, null),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(users.remove).not.toHaveBeenCalled();
  });

  it('ni bloquea a un chofer', async () => {
    alcance(RoleType.DELIVERY);
    await expect(
      controller.blockUser('x', { block: true }, superAdmin, null),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(users.toggleBlockUser).not.toHaveBeenCalled();
  });

  it('con la distribuidora en contexto sí opera (si el usuario es de ella)', async () => {
    alcance(RoleType.DELIVERY);
    await controller.remove('x', superAdmin, 'd1');
    expect(users.perteneceA).toHaveBeenCalledWith('x', 'd1');
    expect(users.remove).toHaveBeenCalledWith('x', { autorizar: undefined });
  });

  it('con la distribuidora de otro: 404', async () => {
    users.perteneceA.mockResolvedValue(false);
    await expect(
      controller.remove('x', superAdmin, 'd1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('sobre otro super admin no hace falta distribuidora', async () => {
    alcance(RoleType.SUPER_ADMIN);
    await controller.remove('otra-cuenta', superAdmin, null);
    expect(users.remove).toHaveBeenCalledWith('otra-cuenta', {
      autorizar: undefined,
    });
  });

  it('un cliente no existe para las mutaciones de la plataforma', async () => {
    alcance(RoleType.CUSTOMER);
    await expect(
      controller.remove('otra-cuenta', superAdmin, null),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(users.remove).not.toHaveBeenCalled();
  });

  it('el admin de empresa trae siempre su distribuidora: no cambia', async () => {
    alcance(RoleType.DELIVERY);
    await controller.remove('x', admin, 'd1');
    expect(users.remove).toHaveBeenCalledWith('x', {
      autorizar: expect.any(Function) as unknown,
    });
  });
});
