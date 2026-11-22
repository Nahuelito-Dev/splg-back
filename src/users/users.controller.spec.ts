import {
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UserPhotoService } from './user-photo.service';
import { User } from './entities/user.entity';
import { RoleType } from '../common/constants/role-type.enum';
import { DownloadMode } from '../s3/dto/download-link.dto';
import { AlcanceGuard } from '../common/guards/alcance.guard';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { AutoridadSobreCuentas } from '../common/permisos/autoridad-sobre-cuentas';

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
    findOneByPhone: jest.Mock;
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
  let autoridad: { assertPuedeAdministrarA: jest.Mock };

  beforeEach(() => {
    service = {
      findOne: jest.fn().mockResolvedValue(fila),
      findOneByEmail: jest.fn().mockResolvedValue(fila),
      findOneByPhone: jest.fn().mockResolvedValue(fila),
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
    autoridad = {
      assertPuedeAdministrarA: jest.fn().mockResolvedValue(undefined),
    };
    controller = new UsersController(
      service as unknown as UsersService,
      photo as unknown as UserPhotoService,
      autoridad as unknown as AutoridadSobreCuentas,
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
        'demo',
      ),
    ).resolves.toBeDefined();
    await expect(
      controller.findOne('yo', usuario(RoleType.SUPER_ADMIN), 'demo'),
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

  it.each([RoleType.ADMIN, RoleType.SUPER_ADMIN])(
    'nadie se da de baja a sí mismo (%s): 403 y no llega al servicio',
    async (rol) => {
      await expect(
        controller.remove('yo', usuario(rol, 'yo'), null),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.remove).not.toHaveBeenCalled();
    },
  );

  it('la auto-baja se detecta aunque el UUID venga en mayúsculas', async () => {
    const yo = usuario(
      RoleType.SUPER_ADMIN,
      'abcdef01-0000-4000-8000-000000000001',
    );
    await expect(
      controller.remove('ABCDEF01-0000-4000-8000-000000000001', yo, null),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.remove).not.toHaveBeenCalled();
  });

  it('nadie se bloquea a sí mismo, ni por /block ni por PATCH, en mayúsculas o no (403)', async () => {
    const yo = usuario(
      RoleType.SUPER_ADMIN,
      'abcdef01-0000-4000-8000-000000000001',
    );
    const mio = 'ABCDEF01-0000-4000-8000-000000000001';
    await expect(
      controller.blockUser(mio, { block: true }, yo, null),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.update(mio, { blocked: true }, yo, null),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.toggleBlockUser).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
  });

  it('la plataforma no administra a un cliente', async () => {
    service.findAlcance.mockResolvedValue({ rol: RoleType.CUSTOMER });
    await expect(
      controller.blockUser(
        'otro',
        { block: true },
        usuario(RoleType.SUPER_ADMIN),
        null,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(service.toggleBlockUser).not.toHaveBeenCalled();
  });

  it('la plataforma ve por id y teléfono sólo super admins y admins de empresa', async () => {
    service.findAlcance.mockResolvedValue({ rol: RoleType.ADMIN });
    await expect(
      controller.findOne('otro', usuario(RoleType.SUPER_ADMIN), null),
    ).resolves.toBeDefined();
    await expect(
      controller.findOneByPhone(
        { phoneNumber: '+5493764000000' },
        usuario(RoleType.SUPER_ADMIN),
        null,
      ),
    ).resolves.toBeDefined();

    service.findAlcance.mockResolvedValue({ rol: RoleType.DELIVERY });
    await expect(
      controller.findOne('otro', usuario(RoleType.SUPER_ADMIN), null),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      controller.findOneByPhone(
        { phoneNumber: '+5493764000000' },
        usuario(RoleType.SUPER_ADMIN),
        null,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
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
    expect(service.update).toHaveBeenCalledWith(
      'yo',
      { full_name: 'Ana', phone_number: '+5493764000000' },
      undefined,
    );
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

    it('la plataforma no modifica la foto de un cliente', async () => {
      service.findAlcance.mockResolvedValue({ rol: RoleType.CUSTOMER });
      await expect(
        controller.uploadPhoto(
          'otro',
          undefined,
          usuario(RoleType.SUPER_ADMIN),
          null,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(photo.subir).not.toHaveBeenCalled();
    });

    it('un cliente no ve la foto de otro (403)', async () => {
      await expect(
        controller.getPhoto('otro', {}, usuario(RoleType.CUSTOMER), null, resp),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(photo.enlace).not.toHaveBeenCalled();
    });

    const EN_JSON = { modo: DownloadMode.URL };

    it.each([RoleType.ADMIN, RoleType.SUPER_ADMIN])(
      'la plataforma, sin sesión de soporte, renueva la foto de una cuenta que ya ve (%s)',
      async (rol) => {
        service.findAlcance.mockResolvedValue({ rol });
        await controller.getPhoto(
          'otro',
          EN_JSON,
          usuario(RoleType.SUPER_ADMIN),
          null,
          resp,
        );
        expect(photo.enlace).toHaveBeenCalledWith('otro');
      },
    );

    it.each([RoleType.CUSTOMER, RoleType.DELIVERY])(
      'la plataforma, sin sesión de soporte, no ve la foto de un %s (404)',
      async (rol) => {
        service.findAlcance.mockResolvedValue({ rol });
        await expect(
          controller.getPhoto(
            'otro',
            EN_JSON,
            usuario(RoleType.SUPER_ADMIN),
            null,
            resp,
          ),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(photo.enlace).not.toHaveBeenCalled();
      },
    );

    it('en modo soporte el super admin ve las de esa empresa, como un admin (cliente incluido), y no las de otra', async () => {
      const enSoporte = {
        ...usuario(RoleType.SUPER_ADMIN),
        support_session_id: 's1',
      };
      service.findAlcance.mockResolvedValue({ rol: RoleType.CUSTOMER });
      await controller.getPhoto('otro', EN_JSON, enSoporte, 'd1', resp);
      expect(service.perteneceA).toHaveBeenCalledWith('otro', 'd1');
      expect(photo.enlace).toHaveBeenCalledWith('otro');
      service.perteneceA.mockResolvedValue(false);
      await expect(
        controller.getPhoto('ajeno', EN_JSON, enSoporte, 'd1', resp),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('el admin de empresa ve la de su gente y no la de otra distribuidora (404), como antes', async () => {
      await controller.getPhoto(
        'otro',
        EN_JSON,
        usuario(RoleType.ADMIN),
        'd1',
        resp,
      );
      expect(photo.enlace).toHaveBeenCalledWith('otro');
      expect(service.findAlcance).not.toHaveBeenCalled();
      service.perteneceA.mockResolvedValue(false);
      await expect(
        controller.getPhoto(
          'ajeno',
          EN_JSON,
          usuario(RoleType.ADMIN),
          'd1',
          resp,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('de las fotos de usuarios, la plataforma sin sesión sólo puede LEER: subir y quitar siguen pidiendo la sesión', () => {
      const guard = new AlcanceGuard(new Reflector());
      const intentar = (
        metodo: 'getPhoto' | 'uploadPhoto' | 'removePhoto',
        verbo: string,
      ): true | string => {
        const ctx = {
          getType: () => 'http',
          switchToHttp: () => ({
            getRequest: () => ({
              method: verbo,
              path: '/users/x/photo',
              user: usuario(RoleType.SUPER_ADMIN),
            }),
          }),
          getHandler: () => UsersController.prototype[metodo],
          getClass: () => UsersController,
        } as unknown as ExecutionContext;
        try {
          return guard.canActivate(ctx) as true;
        } catch (error) {
          return (error as { response: { code: string } }).response.code;
        }
      };
      expect(intentar('getPhoto', 'GET')).toBe(true);
      expect(intentar('uploadPhoto', 'PUT')).toBe('SUPPORT_SESSION_REQUIRED');
      expect(intentar('removePhoto', 'DELETE')).toBe(
        'SUPPORT_SESSION_REQUIRED',
      );
    });
  });

  it('el super admin sube y saca su propia foto aunque esté en "ver como" otra distribuidora', async () => {
    service.perteneceA.mockResolvedValue(false);
    const yo = usuario(RoleType.SUPER_ADMIN, 'sa');
    const archivo = {} as Express.Multer.File;
    await controller.uploadPhoto('sa', archivo, yo, 'dA');
    await controller.removePhoto('sa', yo, 'dA');
    expect(photo.subir).toHaveBeenCalledWith('sa', archivo);
    expect(photo.quitar).toHaveBeenCalledWith('sa');
    // La de otro usuario sigue acotada por distribuidora.
    await expect(
      controller.uploadPhoto('otro', archivo, yo, 'dA'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('nadie sube ni baja a quien tiene más permisos (regla sobre cuentas de otros)', () => {
    const rechazo = () =>
      new ForbiddenException({
        statusCode: 403,
        message: 'No',
        code: 'STAFF_ROLE_TARGET_OUTRANKS',
      });

    beforeEach(() => {
      service.findAlcance.mockResolvedValue({
        rol: RoleType.ADMIN,
        distributorId: 'd1',
      });
    });

    it('PATCH sobre otro admin consulta la regla con la contraseña, y si la regla dice que no, no escribe', async () => {
      const yo = usuario(RoleType.ADMIN);
      autoridad.assertPuedeAdministrarA.mockRejectedValue(rechazo());
      await expect(
        controller.update('otro', { password: 'NuevaClave1' }, yo, 'd1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(autoridad.assertPuedeAdministrarA).toHaveBeenCalledWith(
        yo,
        { userId: 'otro', rol: RoleType.ADMIN },
        'd1',
        { cambiaContraseña: true },
      );
      expect(service.update).not.toHaveBeenCalled();
    });

    it('PATCH sin contraseña avisa que no la cambia', async () => {
      const yo = usuario(RoleType.ADMIN);
      await controller.update('otro', { full_name: 'Otro' }, yo, 'd1');
      expect(autoridad.assertPuedeAdministrarA).toHaveBeenCalledWith(
        yo,
        { userId: 'otro', rol: RoleType.ADMIN },
        'd1',
        { cambiaContraseña: false },
      );
      expect(service.update).toHaveBeenCalled();
    });

    it('la baja y el bloqueo de un admin pasan por la regla', async () => {
      const yo = usuario(RoleType.ADMIN);
      autoridad.assertPuedeAdministrarA.mockRejectedValue(rechazo());
      await expect(controller.remove('otro', yo, 'd1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(
        controller.blockUser('otro', { block: true }, yo, 'd1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.remove).not.toHaveBeenCalled();
      expect(service.toggleBlockUser).not.toHaveBeenCalled();
    });

    it('un chofer también pasa por la regla (pide personal.gestionar)', async () => {
      service.findAlcance.mockResolvedValue({
        rol: RoleType.DELIVERY,
        distributorId: 'd1',
      });
      const yo = usuario(RoleType.ADMIN);
      await controller.remove('otro', yo, 'd1');
      expect(autoridad.assertPuedeAdministrarA).toHaveBeenCalledWith(
        yo,
        { userId: 'otro', rol: RoleType.DELIVERY },
        'd1',
        {},
      );
      // La misma regla viaja a la transacción de la baja, con su manager.
      const [, opciones] = service.remove.mock.calls[0] as [
        string,
        { autorizar: (m: unknown) => Promise<void> },
      ];
      const tx = { transaccion: true };
      await opciones.autorizar(tx);
      expect(autoridad.assertPuedeAdministrarA).toHaveBeenLastCalledWith(
        yo,
        { userId: 'otro', rol: RoleType.DELIVERY },
        'd1',
        { manager: tx },
      );
    });

    it('la foto de otro admin también', async () => {
      autoridad.assertPuedeAdministrarA.mockRejectedValue(rechazo());
      await expect(
        controller.removePhoto('otro', usuario(RoleType.ADMIN), 'd1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(photo.quitar).not.toHaveBeenCalled();
    });

    it('el super admin pasa siempre: no consulta la regla', async () => {
      await controller.update(
        'otro',
        { password: 'NuevaClave1' },
        usuario(RoleType.SUPER_ADMIN),
        'd1',
      );
      expect(autoridad.assertPuedeAdministrarA).not.toHaveBeenCalled();
      expect(service.update).toHaveBeenCalledWith(
        'otro',
        { password: 'NuevaClave1' },
        undefined,
      );
    });
  });
});
