import { CustomersController } from './customer.controller';
import { CustomersService } from './customer.service';
import { UserPhotoService } from '../users/user-photo.service';
import { Customer } from './entities/customer.entity';
import { User } from '../users/entities/user.entity';
import { RoleType } from '../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

/**
 * Actualización del perfil. La validación de clientes se eliminó el 26/09: el
 * cliente se registra y compra, no hay nada que aprobar.
 */
describe('CustomersController — actualización', () => {
  let controller: CustomersController;
  let service: {
    update: jest.Mock;
    findOne: jest.Mock;
    findAll: jest.Mock;
  };

  const usuario = (role: RoleType): AuthenticatedUser => ({
    user_id: 'u1',
    email: 'a@splg.com',
    role,
  });

  beforeEach(() => {
    service = {
      findOne: jest.fn(),
      findAll: jest.fn(),
      update: jest
        .fn()
        .mockResolvedValue({ customer_id: 'c1', user_id: 'u1', user: null }),
    };
    controller = new CustomersController(
      service as unknown as CustomersService,
      {
        firmar: jest.fn().mockImplementation((usuarios?: User | User[]) => {
          for (const u of Array.isArray(usuarios) ? usuarios : [usuarios]) {
            if (u) u.photoSignedUrl = `https://s3.test/${u.userId}`;
          }
          return Promise.resolve();
        }),
      } as unknown as UserPhotoService,
    );
  });

  it('un cliente puede cambiar sus datos', async () => {
    await controller.update(
      'c1',
      { lat_lang: '-27.3,-55.8' },
      usuario(RoleType.CUSTOMER),
      null,
    );
    expect(service.update).toHaveBeenCalledWith(
      'c1',
      { lat_lang: '-27.3,-55.8' },
      'u1',
    );
  });

  it('un administrador actualiza sin quedar acotado a un dueño', async () => {
    await controller.update(
      'c1',
      { notification_token: 'tok' },
      usuario(RoleType.ADMIN),
      null,
    );
    expect(service.update).toHaveBeenCalledWith(
      'c1',
      { notification_token: 'tok' },
      undefined,
    );
  });

  describe('foto del usuario anidado', () => {
    const cliente = (id: string) =>
      ({
        customerId: `c-${id}`,
        userId: id,
        user: { userId: id, photoKey: `users/${id}/a.jpg` },
      }) as unknown as Customer;

    it('el detalle devuelve user.photoUrl firmada', async () => {
      service.findOne.mockResolvedValue(cliente('u1'));
      const dto = await controller.findOne(
        'c1',
        usuario(RoleType.CUSTOMER),
        null,
      );
      expect(dto.user?.photoUrl).toBe('https://s3.test/u1');
    });

    it('el listado firma a todos', async () => {
      service.findAll.mockResolvedValue([[cliente('u1'), cliente('u2')], 2]);
      const res = { setHeader: jest.fn() } as never;
      const dtos = await controller.findAll({} as never, res, null);
      expect(dtos.map((d) => d.user?.photoUrl)).toEqual([
        'https://s3.test/u1',
        'https://s3.test/u2',
      ]);
    });
  });
});
