import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { User } from './entities/user.entity';
import { RoleType } from '../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

/**
 * Quién ve y quién administra una cuenta (H-62, H-65, H-66, H-73, H-76): cada
 * uno la suya; un admin de empresa, sólo el personal de su distribuidora; la
 * cuenta de un cliente, sólo el administrador general.
 */
describe('UsersController — alcance', () => {
  let controller: UsersController;
  let service: {
    findOne: jest.Mock;
    findOneByEmail: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
    toggleBlockUser: jest.Mock;
    perteneceA: jest.Mock;
    findAlcance: jest.Mock;
  };

  const usuario = (role: RoleType, user_id = 'yo'): AuthenticatedUser => ({
    user_id,
    email: 'yo@splg.com',
    role,
  });
  const fila = { user_id: 'otro', blocked: false } as User;

  beforeEach(() => {
    service = {
      findOne: jest.fn().mockResolvedValue(fila),
      findOneByEmail: jest.fn().mockResolvedValue(fila),
      update: jest.fn().mockResolvedValue(fila),
      remove: jest.fn(),
      toggleBlockUser: jest.fn(),
      perteneceA: jest.fn().mockResolvedValue(true),
      findAlcance: jest.fn().mockResolvedValue({ rol: RoleType.DELIVERY }),
    };
    controller = new UsersController(service as unknown as UsersService);
  });

  it('un cliente no lee la cuenta de otro', async () => {
    await expect(
      controller.findOne('otro', usuario(RoleType.CUSTOMER), null),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.findOneByEmail(
        { email: 'otro@splg.com' },
        usuario(RoleType.CUSTOMER),
        null,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('la respuesta sale por el mapper, sin firebase_uid', async () => {
    service.findOne.mockResolvedValue({ ...fila, firebase_uid: 'secreto' });
    const dto = await controller.findOne(
      'yo',
      usuario(RoleType.CUSTOMER),
      null,
    );
    expect(dto).not.toHaveProperty('firebase_uid');
  });

  it('un usuario de otra distribuidora no existe para el admin', async () => {
    service.perteneceA.mockResolvedValue(false);
    await expect(
      controller.findOne('otro', usuario(RoleType.ADMIN), 'd1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(service.findOne).not.toHaveBeenCalled();
  });

  it('un admin de empresa no administra la cuenta de un cliente', async () => {
    service.findAlcance.mockResolvedValue({ rol: RoleType.CUSTOMER });
    await expect(
      controller.blockUser(
        'otro',
        { block: true },
        usuario(RoleType.ADMIN),
        'd1',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.toggleBlockUser).not.toHaveBeenCalled();
  });

  it('para un admin de empresa el super admin no existe', async () => {
    service.findAlcance.mockResolvedValue({ rol: RoleType.SUPER_ADMIN });
    await expect(
      controller.remove('otro', usuario(RoleType.ADMIN), 'd1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(service.remove).not.toHaveBeenCalled();
  });

  it('el administrador general sí administra a un cliente', async () => {
    service.findAlcance.mockResolvedValue({ rol: RoleType.CUSTOMER });
    await controller.blockUser(
      'otro',
      { block: true },
      usuario(RoleType.SUPER_ADMIN),
      null,
    );
    expect(service.toggleBlockUser).toHaveBeenCalledWith('otro', true);
  });

  it('quien no es admin no cambia contraseña ni bloqueo', async () => {
    await expect(
      controller.update(
        'yo',
        { password: 'Nueva1234' },
        usuario(RoleType.DELIVERY),
        null,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('de su propio perfil, cada uno cambia sólo nombre, teléfono y foto', async () => {
    await controller.update(
      'yo',
      { full_name: 'Ana', phone_number: '+5493764000000' },
      usuario(RoleType.CUSTOMER),
      null,
    );
    expect(service.update).toHaveBeenCalledWith('yo', {
      full_name: 'Ana',
      phone_number: '+5493764000000',
    });
  });
});
