import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { UsersService } from './users.service';
import { User } from './entities/user.entity';
import { FirebaseAuthPort } from '../firebase/ports/firebase-auth.port';

describe('UsersService', () => {
  let service: UsersService;
  let users: {
    exists: jest.Mock;
    findOne: jest.Mock;
    delete: jest.Mock;
    softRemove: jest.Mock;
    preload: jest.Mock;
  };
  let firebase: { deleteUserSafe: jest.Mock; updateUser: jest.Mock };

  beforeEach(() => {
    users = {
      exists: jest.fn().mockResolvedValue(false),
      findOne: jest.fn(),
      delete: jest.fn(),
      softRemove: jest.fn(),
      preload: jest.fn(),
    };
    firebase = { deleteUserSafe: jest.fn(), updateUser: jest.fn() };
    service = new UsersService(
      users as unknown as Repository<User>,
      {} as DataSource,
      {} as ConfigService,
      firebase as unknown as FirebaseAuthPort,
    );
  });

  describe('checkUserExists', () => {
    it('informa el correo y el teléfono por separado', async () => {
      // El correo está libre; el teléfono lo usa otra persona.
      users.exists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      await expect(
        service.checkUserExists('libre@splg.com', '+5493764000000'),
      ).resolves.toEqual({ exists: true, email: false, phoneNumber: true });
    });

    it('sin datos no consulta la base', async () => {
      await expect(service.checkUserExists()).resolves.toEqual({
        exists: false,
        email: false,
        phoneNumber: false,
      });
      expect(users.exists).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('da de baja lógica al usuario y a sus perfiles, sin borrar', async () => {
      const user = { user_id: 'u1', firebase_uid: 'fb' };
      users.findOne.mockResolvedValue(user);
      await service.remove('u1');
      expect(users.findOne).toHaveBeenCalledWith({
        where: { user_id: 'u1' },
        relations: ['customer', 'delivery', 'cars', 'addresses'],
      });
      expect(users.softRemove).toHaveBeenCalledWith(user);
      expect(users.delete).not.toHaveBeenCalled();
    });

    it('deshabilita la cuenta de Firebase en vez de borrarla', async () => {
      users.findOne.mockResolvedValue({ user_id: 'u1', firebase_uid: 'fb' });
      await service.remove('u1');
      expect(firebase.updateUser).toHaveBeenCalledWith('fb', {
        disabled: true,
      });
      expect(firebase.deleteUserSafe).not.toHaveBeenCalled();
    });

    it('si Firebase falla, la baja igual queda hecha', async () => {
      users.findOne.mockResolvedValue({ user_id: 'u1', firebase_uid: 'fb' });
      firebase.updateUser.mockRejectedValue(new Error('caído'));
      await expect(service.remove('u1')).resolves.toEqual({
        message: 'Usuario dado de baja',
      });
    });

    it('un usuario inexistente es 404', async () => {
      users.findOne.mockResolvedValue(null);
      await expect(service.remove('u9')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  it('no cambia la contraseña de quien no tiene cuenta de acceso', async () => {
    users.preload.mockResolvedValue({ user_id: 'u1', firebase_uid: null });
    await expect(
      service.update('u1', { password: 'Nueva1234' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(firebase.updateUser).not.toHaveBeenCalled();
  });
});
