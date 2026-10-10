import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UserPhotoService } from './user-photo.service';
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
  let photo: {
    firmar: jest.Mock;
    subir: jest.Mock;
    quitar: jest.Mock;
    enlace: jest.Mock;
  };
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
  const fila = { userId: 'otro', blocked: false } as User;

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
    photo = {
      firmar: jest.fn().mockResolvedValue(undefined),
      subir: jest.fn().mockResolvedValue({ userId: 'x' }),
      quitar: jest.fn().mockResolvedValue({ userId: 'x' }),
      enlace: jest.fn().mockResolvedValue({ kind: 'none' }),
    };
    controller = new UsersController(
      service as unknown as UsersService,
      photo as unknown as UserPhotoService,
    );
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

  it('el super admin con "Ver como" se lee a sí mismo aunque no sea de esa distribuidora', async () => {
    service.findOneByEmail.mockResolvedValue({ userId: 'yo', blocked: false });
    service.perteneceA.mockResolvedValue(false);
    await expect(
      controller.findOneByEmail(
        { email: 'yo@splg.com' },
        usuario(RoleType.SUPER_ADMIN),
        'jeny',
      ),
    ).resolves.toBeDefined();
    await expect(
      controller.findOne('yo', usuario(RoleType.SUPER_ADMIN), 'jeny'),
    ).resolves.toBeDefined();
    expect(service.perteneceA).not.toHaveBeenCalled();
  });

  it('buscar por email a alguien de otra distribuidora no revela su id', async () => {
    service.perteneceA.mockResolvedValue(false);
    const error: unknown = await controller
      .findOneByEmail({ email: 'otro@splg.com' }, usuario(RoleType.ADMIN), 'd1')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).not.toContain('otro');
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

  describe('foto de perfil', () => {
    const resp = {
      json: jest.fn(),
      redirect: jest.fn(),
    } as unknown as Response;

    it('cada usuario sube y saca la suya por /me/photo, sin pasar id', async () => {
      await controller.uploadMyPhoto(undefined, usuario(RoleType.CUSTOMER));
      await controller.removeMyPhoto(usuario(RoleType.CUSTOMER));
      expect(photo.subir).toHaveBeenCalledWith('yo', undefined);
      expect(photo.quitar).toHaveBeenCalledWith('yo');
    });

    it('el admin de empresa sube la foto de un chofer de su distribuidora', async () => {
      await controller.uploadPhoto(
        'chofer',
        undefined,
        usuario(RoleType.ADMIN),
        'd1',
      );
      expect(photo.subir).toHaveBeenCalledWith('chofer', undefined);
    });

    it('el admin de empresa no toca la foto de un cliente (403)', async () => {
      service.findAlcance.mockResolvedValue({ rol: RoleType.CUSTOMER });
      await expect(
        controller.uploadPhoto(
          'otro',
          undefined,
          usuario(RoleType.ADMIN),
          'd1',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        controller.removePhoto('otro', usuario(RoleType.ADMIN), 'd1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(photo.subir).not.toHaveBeenCalled();
      expect(photo.quitar).not.toHaveBeenCalled();
    });

    it('un usuario de otra distribuidora no existe para el admin (404)', async () => {
      service.perteneceA.mockResolvedValue(false);
      await expect(
        controller.uploadPhoto(
          'otro',
          undefined,
          usuario(RoleType.ADMIN),
          'd1',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(photo.subir).not.toHaveBeenCalled();
    });

    it('el administrador general sí sube la foto de un cliente', async () => {
      service.findAlcance.mockResolvedValue({ rol: RoleType.CUSTOMER });
      await controller.uploadPhoto(
        'otro',
        undefined,
        usuario(RoleType.SUPER_ADMIN),
        null,
      );
      expect(photo.subir).toHaveBeenCalledWith('otro', undefined);
    });

    it('un cliente no ve la foto de otro (403)', async () => {
      await expect(
        controller.getPhoto('otro', {}, usuario(RoleType.CUSTOMER), null, resp),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(photo.enlace).not.toHaveBeenCalled();
    });
  });
});
