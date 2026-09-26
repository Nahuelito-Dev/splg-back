import { CustomersController } from './customer.controller';
import { CustomersService } from './customer.service';
import { RoleType } from '../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

/**
 * Actualización del perfil. La validación de clientes se eliminó el 26/09: el
 * cliente se registra y compra, no hay nada que aprobar.
 */
describe('CustomersController — actualización', () => {
  let controller: CustomersController;
  let service: { update: jest.Mock };

  const usuario = (role: RoleType): AuthenticatedUser => ({
    user_id: 'u1',
    email: 'a@splg.com',
    role,
  });

  beforeEach(() => {
    service = {
      update: jest
        .fn()
        .mockResolvedValue({ customer_id: 'c1', user_id: 'u1', user: null }),
    };
    controller = new CustomersController(
      service as unknown as CustomersService,
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
});
