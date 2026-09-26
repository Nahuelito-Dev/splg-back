import { ForbiddenException } from '@nestjs/common';
import { CustomersController } from './customer.controller';
import { CustomersService } from './customer.service';
import { RoleType } from '../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

/** H-52: un cliente no puede cambiar su propia validación. */
describe('CustomersController — validación', () => {
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

  it('un cliente que manda validated recibe 403', async () => {
    await expect(
      controller.update(
        'c1',
        { validated: true },
        usuario(RoleType.CUSTOMER),
        null,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('un cliente puede cambiar sus otros datos', async () => {
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

  it('un administrador sí valida', async () => {
    await controller.update(
      'c1',
      { validated: true },
      usuario(RoleType.ADMIN),
      null,
    );
    expect(service.update).toHaveBeenCalledWith(
      'c1',
      { validated: true },
      undefined,
    );
  });
});
