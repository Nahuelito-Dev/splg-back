import { BadRequestException } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { RoleType } from '../common/constants/role-type.enum';
import { MENSAJE_FALTA_DISTRIBUIDORA } from '../common/decorators/current-distributor.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

/**
 * `PATCH` y `DELETE /admin/:id`: el super admin tiene que decir en qué
 * distribuidora actúa (`X-Distributor`), salvo sobre otro super admin.
 */
describe('AdminController · distribuidora en las escrituras', () => {
  const superAdmin = {
    user_id: 'sup',
    role: RoleType.SUPER_ADMIN,
  } as AuthenticatedUser;
  let service: {
    findDetail: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
    esDeUnaDistribuidoraEliminada: jest.Mock;
  };
  let controller: AdminController;

  const destino = (rol: RoleType) =>
    service.findDetail.mockResolvedValue({
      userId: 'u-destino',
      user: { role: { type: rol } },
    });

  beforeEach(() => {
    service = {
      findDetail: jest.fn(),
      update: jest.fn().mockResolvedValue({ adminId: 'a1', user: {} }),
      remove: jest.fn().mockResolvedValue({ message: 'ok' }),
      esDeUnaDistribuidoraEliminada: jest.fn().mockResolvedValue(false),
    };
    controller = new AdminController(service as never);
  });

  it('super admin sin distribuidora no edita ni da de baja a un admin de empresa: 400', async () => {
    destino(RoleType.ADMIN);
    await expect(
      controller.update('a1', { fullName: 'Nuevo nombre' }, superAdmin, null),
    ).rejects.toThrow(new BadRequestException(MENSAJE_FALTA_DISTRIBUIDORA));
    await expect(controller.remove('a1', superAdmin, null)).rejects.toThrow(
      new BadRequestException(MENSAJE_FALTA_DISTRIBUIDORA),
    );
    expect(service.update).not.toHaveBeenCalled();
    expect(service.remove).not.toHaveBeenCalled();
  });

  it('sin distribuidora da de baja (sólo la baja) al admin de una distribuidora eliminada', async () => {
    destino(RoleType.ADMIN);
    service.esDeUnaDistribuidoraEliminada.mockResolvedValue(true);
    await controller.remove('a1', superAdmin, null);
    expect(service.remove).toHaveBeenCalledWith('a1', null);
    // Editarlo sigue pidiendo la distribuidora.
    await expect(
      controller.update('a1', { fullName: 'Nuevo nombre' }, superAdmin, null),
    ).rejects.toThrow(new BadRequestException(MENSAJE_FALTA_DISTRIBUIDORA));
  });

  it('con la distribuidora en contexto sí', async () => {
    destino(RoleType.ADMIN);
    await controller.remove('a1', superAdmin, 'd1');
    expect(service.remove).toHaveBeenCalledWith('a1', 'd1');
  });

  it('sobre otro super admin no hace falta', async () => {
    destino(RoleType.SUPER_ADMIN);
    await controller.remove('a1', superAdmin, null);
    expect(service.remove).toHaveBeenCalledWith('a1', null);
  });
});
