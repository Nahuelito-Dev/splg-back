import { NotFoundException } from '@nestjs/common';
import { RoleType } from '../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { UsersService } from '../users/users.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

describe('NotificationsController · tokens de plataforma', () => {
  const superAdmin: AuthenticatedUser = {
    user_id: 'super',
    email: 'super@splg.com',
    role: RoleType.SUPER_ADMIN,
  };

  let notifications: { getUserNotificationTokens: jest.Mock };
  let users: { findAlcance: jest.Mock };
  let controller: NotificationsController;

  beforeEach(() => {
    notifications = {
      getUserNotificationTokens: jest.fn().mockResolvedValue({ tokens: [] }),
    };
    users = {
      findAlcance: jest.fn().mockResolvedValue({ rol: RoleType.ADMIN }),
    };
    controller = new NotificationsController(
      notifications as unknown as NotificationsService,
      users as unknown as UsersService,
    );
  });

  it('la plataforma consulta tokens de sus admins', async () => {
    await expect(
      controller.getUserTokens('admin', superAdmin),
    ).resolves.toEqual({ tokens: [] });
    expect(notifications.getUserNotificationTokens).toHaveBeenCalledWith(
      'admin',
    );
  });

  it.each([RoleType.CUSTOMER, RoleType.DELIVERY])(
    'la plataforma no revela los tokens de un %s',
    async (rol) => {
      users.findAlcance.mockResolvedValue({ rol });
      await expect(
        controller.getUserTokens('operativo', superAdmin),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(notifications.getUserNotificationTokens).not.toHaveBeenCalled();
    },
  );
});
