import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';
import { Delivery } from './entities/delivery.entity';
import { UserPhotoService } from '../users/user-photo.service';
import { User } from '../users/entities/user.entity';
import { RoleType } from '../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

/**
 * H-64 y H-80: un chofer sólo opera sobre sí mismo, y un admin con
 * distribuidora en contexto sólo sobre los choferes de ella.
 */
describe('DeliveryController — alcance', () => {
  let controller: DeliveryController;
  let service: {
    findOne: jest.Mock;
    assertAlcance: jest.Mock;
    validateDelivery: jest.Mock;
    remove: jest.Mock;
    toggleAvailability: jest.Mock;
  };
  let firmar: jest.Mock;

  const usuario = (role: RoleType, user_id = 'yo'): AuthenticatedUser => ({
    user_id,
    email: 'yo@splg.com',
    role,
  });
  const chofer = {
    deliveryId: 'dl1',
    distributorId: 'dB',
    userId: 'u-chofer',
    validated: true,
    isActive: true,
    balance: 0,
    notificationToken: 'token-del-dispositivo',
  } as Delivery;

  beforeEach(() => {
    const real = new DeliveryService({} as never, {} as never, {} as never);
    service = {
      findOne: jest.fn().mockResolvedValue(chofer),
      // La regla es la del servicio real: se prueba tal cual.
      assertAlcance: jest.fn(real.assertAlcance.bind(real)),
      validateDelivery: jest.fn().mockResolvedValue(chofer),
      remove: jest.fn(),
      toggleAvailability: jest.fn(),
    };
    // Firmar completa el campo transitorio, como el servicio real.
    firmar = jest.fn().mockImplementation((usuario?: User) => {
      if (usuario) usuario.photoSignedUrl = `https://s3.test/${usuario.userId}`;
      return Promise.resolve();
    });
    controller = new DeliveryController(
      service as unknown as DeliveryService,
      {
        firmar,
      } as unknown as UserPhotoService,
    );
  });

  it('el chofer de otra distribuidora no existe para el admin', async () => {
    await expect(
      controller.validateDelivery('dl1', 'dA'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.remove('dl1', 'dA')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(service.validateDelivery).not.toHaveBeenCalled();
    expect(service.remove).not.toHaveBeenCalled();
  });

  it('el admin de la misma distribuidora sí lo valida', async () => {
    await controller.validateDelivery('dl1', 'dB');
    expect(service.validateDelivery).toHaveBeenCalledWith('dl1');
  });

  it('un chofer no lee el perfil de otro', async () => {
    await expect(
      controller.findOne('dl1', usuario(RoleType.DELIVERY, 'otro'), 'dB'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('un chofer no cambia la disponibilidad de otro', async () => {
    await expect(
      controller.toggleAvailability(
        'u-chofer',
        { available: false },
        usuario(RoleType.DELIVERY, 'otro'),
        'dB',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.toggleAvailability).not.toHaveBeenCalled();
  });

  it('la respuesta no expone el token push del dispositivo', async () => {
    const dto = await controller.findOne(
      'dl1',
      usuario(RoleType.DELIVERY, 'u-chofer'),
      'dB',
    );
    expect(dto).not.toHaveProperty('notification_token');
  });

  it('firma la foto del usuario del chofer en el detalle', async () => {
    const conUsuario = {
      ...chofer,
      user: { userId: 'u-chofer', photoKey: 'users/u-chofer/a.jpg' } as User,
    } as Delivery;
    service.findOne.mockResolvedValue(conUsuario);
    const dto = await controller.findOne(
      'dl1',
      usuario(RoleType.DELIVERY, 'u-chofer'),
      'dB',
    );
    expect(dto.user?.photoUrl).toBe('https://s3.test/u-chofer');
  });
});
