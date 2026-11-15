import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EmailService } from './email.service';
import { EmailTemplateProvider } from './email-template.provider';
import { EmailSenderPort } from './ports/email-sender.port';
import { UsersService } from '../users/users.service';
import { FirebaseAuthPort } from '../firebase/ports/firebase-auth.port';
import { RedisService } from '../redis/redis.service';
import { EnlacesDeLaApp } from './enlaces-de-la-app';

/**
 * EmailService, orquestador SIN el SDK de Resend ni Maps en memoria:
 * `EmailSenderPort` y `RedisService` van mockeados (nunca contra Redis/Resend
 * real). Foco de estos tests: que el rate-limit y el cache de links pasen
 * por Redis (no por estado en memoria del proceso) y que los emails sigan
 * siendo best-effort (un fallo del sender nunca revienta el flujo).
 */
describe('EmailService', () => {
  let service: EmailService;
  let usersService: { findOneByEmail: jest.Mock; cambiarEmail: jest.Mock };
  let firebaseAuth: {
    generatePasswordResetLink: jest.Mock;
    verifyIdToken: jest.Mock;
    updateUser: jest.Mock;
  };
  let redisService: {
    incrWithExpire: jest.Mock;
    get: jest.Mock;
    setex: jest.Mock;
  };
  let emailSender: { send: jest.Mock };
  let templates: { renderCorreo: jest.Mock };

  beforeEach(() => {
    usersService = {
      findOneByEmail: jest.fn(),
      cambiarEmail: jest.fn(),
    };
    firebaseAuth = {
      generatePasswordResetLink: jest.fn(),
      verifyIdToken: jest.fn(),
      updateUser: jest.fn(),
    };
    redisService = {
      incrWithExpire: jest.fn().mockResolvedValue(1),
      get: jest.fn().mockResolvedValue(null),
      setex: jest.fn().mockResolvedValue(undefined),
    };
    emailSender = { send: jest.fn().mockResolvedValue(undefined) };
    templates = {
      renderCorreo: jest.fn().mockReturnValue({
        asunto: 'Asunto de la plantilla',
        html: '<p>html</p>',
        text: 'html',
      }),
    };

    service = new EmailService(
      usersService as unknown as UsersService,
      firebaseAuth as unknown as FirebaseAuthPort,
      redisService as unknown as RedisService,
      emailSender as unknown as EmailSenderPort,
      templates as unknown as EmailTemplateProvider,
      {
        accionDeCuenta: 'https://splg.test/__/auth/action',
      } as unknown as EnlacesDeLaApp,
    );
  });

  describe('sendPasswordResetEmail', () => {
    it('chequea el rate-limit contra Redis con la key email:ratelimit:<email>:password_reset', async () => {
      usersService.findOneByEmail.mockResolvedValue({ userId: 'u-1' });
      firebaseAuth.generatePasswordResetLink.mockResolvedValue(
        'https://reset.link/1',
      );

      await service.sendPasswordResetEmail('cliente@test.com');

      expect(redisService.incrWithExpire).toHaveBeenCalledWith(
        'email:ratelimit:cliente@test.com:password_reset',
        60 * 60,
      );
    });

    it('si Redis reporta más intentos que el límite, corta ANTES de tocar Firebase/usersService', async () => {
      redisService.incrWithExpire.mockResolvedValue(11); // límite = 10

      await expect(
        service.sendPasswordResetEmail('cliente@test.com'),
      ).rejects.toThrow(BadRequestException);

      expect(usersService.findOneByEmail).not.toHaveBeenCalled();
      expect(firebaseAuth.generatePasswordResetLink).not.toHaveBeenCalled();
    });

    it('usa el link cacheado en Redis en vez de pedirle uno nuevo a Firebase', async () => {
      usersService.findOneByEmail.mockResolvedValue({ userId: 'u-1' });
      redisService.get.mockResolvedValue('https://reset.link/cached');

      const result = await service.sendPasswordResetEmail('cliente@test.com');

      expect(firebaseAuth.generatePasswordResetLink).not.toHaveBeenCalled();
      expect(emailSender.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'cliente@test.com' }),
      );
      expect(result).toEqual({
        message:
          'Si el correo existe, te enviamos un enlace para restablecer la contraseña',
      });
    });

    it('cachea el link nuevo en Redis con TTL de 30 minutos', async () => {
      usersService.findOneByEmail.mockResolvedValue({ userId: 'u-1' });
      firebaseAuth.generatePasswordResetLink.mockResolvedValue(
        'https://reset.link/nuevo',
      );

      await service.sendPasswordResetEmail('cliente@test.com');

      expect(redisService.setex).toHaveBeenCalledWith(
        'email:link-cache:reset:cliente@test.com',
        30 * 60,
        'https://reset.link/nuevo',
      );
    });

    it('pide el link con el destino de la app, no uno fijo', async () => {
      usersService.findOneByEmail.mockResolvedValue({ userId: 'u-1' });
      firebaseAuth.generatePasswordResetLink.mockResolvedValue('https://r/1');

      await service.sendPasswordResetEmail('cliente@test.com');

      expect(firebaseAuth.generatePasswordResetLink).toHaveBeenCalledWith(
        'cliente@test.com',
        expect.objectContaining({ url: 'https://splg.test/__/auth/action' }),
      );
    });

    it('si Firebase falla, el detalle no llega al llamante', async () => {
      usersService.findOneByEmail.mockResolvedValue({ userId: 'u-1' });
      firebaseAuth.generatePasswordResetLink.mockRejectedValue(
        new Error('UNAUTHORIZED_CONTINUE_URI : Domain not allowlisted'),
      );

      await expect(
        service.sendPasswordResetEmail('cliente@test.com'),
      ).rejects.toThrow(/^No se pudo generar el enlace de recuperación$/);
    });

    it('usuario inexistente: responde genérico (no filtra si el email existe)', async () => {
      const notFound = Object.assign(new Error('not found'), { status: 404 });
      usersService.findOneByEmail.mockRejectedValue(notFound);

      const result = await service.sendPasswordResetEmail('nadie@test.com');

      expect(result).toEqual({
        message:
          'Si el correo existe, te enviamos un enlace para restablecer la contraseña',
      });
    });

    it('un error inesperado no expone el detalle: responde un texto genérico', async () => {
      usersService.findOneByEmail.mockRejectedValue(
        new Error('connection refused 10.0.0.5:5432'),
      );

      const error: unknown = await service
        .sendPasswordResetEmail('cliente@test.com')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toBe(
        'No se pudo enviar el correo de recuperación',
      );
    });

    it('el envío de email es best-effort: si el sender falla, igual devuelve éxito', async () => {
      usersService.findOneByEmail.mockResolvedValue({ userId: 'u-1' });
      firebaseAuth.generatePasswordResetLink.mockResolvedValue(
        'https://reset.link/1',
      );
      emailSender.send.mockRejectedValue(new Error('Resend caído'));

      const result = await service.sendPasswordResetEmail('cliente@test.com');

      expect(result).toEqual({
        message:
          'Si el correo existe, te enviamos un enlace para restablecer la contraseña',
      });
    });
  });

  describe('sendWelcomeEmail', () => {
    it('saluda con el nombre que trae el alta', async () => {
      await service.sendWelcomeEmail('nuevo@test.com', 'Ana');

      expect(templates.renderCorreo).toHaveBeenCalledWith(
        'welcome',
        expect.objectContaining({ displayName: 'Ana' }),
      );
      expect(emailSender.send).toHaveBeenCalledWith({
        to: 'nuevo@test.com',
        subject: 'Asunto de la plantilla',
        html: '<p>html</p>',
        text: 'html',
      });
    });

    it('best-effort: si el sender falla, no propaga la excepción', async () => {
      emailSender.send.mockRejectedValue(new Error('Resend caído'));

      await expect(
        service.sendWelcomeEmail('nuevo@test.com', 'Ana'),
      ).resolves.toBeUndefined();
    });
  });

  describe('changeEmail', () => {
    it('token que no matchea el email actual: rechaza sin tocar Firebase updateUser', async () => {
      firebaseAuth.verifyIdToken.mockResolvedValue({
        email: 'otro@test.com',
        uid: 'uid-1',
      });

      await expect(
        service.changeEmail('actual@test.com', 'nuevo@test.com', 'token'),
      ).rejects.toThrow(BadRequestException);

      expect(firebaseAuth.updateUser).not.toHaveBeenCalled();
    });

    it('si Firebase falla al actualizar, el cliente no recibe el detalle del SDK', async () => {
      firebaseAuth.verifyIdToken.mockResolvedValue({
        email: 'actual@test.com',
        uid: 'uid-1',
      });
      usersService.findOneByEmail.mockRejectedValueOnce(
        Object.assign(new Error('not found'), { status: 404 }),
      );
      firebaseAuth.updateUser.mockRejectedValue(
        new Error('proyecto splg-gas: detalle interno del SDK'),
      );

      const error: unknown = await service
        .changeEmail('actual@test.com', 'nuevo@test.com', 'token')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toBe(
        'No se pudo actualizar el correo',
      );
    });

    it('si Firebase dice que el correo nuevo ya existe, informa que está en uso', async () => {
      firebaseAuth.verifyIdToken.mockResolvedValue({
        email: 'actual@test.com',
        uid: 'uid-1',
      });
      usersService.findOneByEmail.mockRejectedValueOnce(
        Object.assign(new Error('not found'), { status: 404 }),
      );
      firebaseAuth.updateUser.mockRejectedValue({
        code: 'auth/email-already-exists',
        message: 'detalle del SDK',
      });

      await expect(
        service.changeEmail('actual@test.com', 'nuevo@test.com', 'token'),
      ).rejects.toThrow('El correo nuevo ya está en uso');
    });

    it('el usuario actual inexistente (404) sigue siendo un 400', async () => {
      firebaseAuth.verifyIdToken.mockResolvedValue({
        email: 'actual@test.com',
        uid: 'uid-1',
      });
      usersService.findOneByEmail
        .mockRejectedValueOnce(new NotFoundException('Usuario no encontrado'))
        .mockRejectedValueOnce(new NotFoundException('Usuario no encontrado'));

      const error: unknown = await service
        .changeEmail('actual@test.com', 'nuevo@test.com', 'token')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toBe(
        'Usuario no encontrado',
      );
    });

    it('flujo feliz: actualiza Firebase + usersService y notifica ambos emails', async () => {
      firebaseAuth.verifyIdToken.mockResolvedValue({
        email: 'actual@test.com',
        uid: 'uid-1',
      });
      const notFound = Object.assign(new Error('not found'), { status: 404 });
      usersService.findOneByEmail
        .mockRejectedValueOnce(notFound) // check newEmail no existe
        .mockResolvedValueOnce({ userId: 'u-1', fullName: 'Nahuel' }); // findOneByEmail(currentEmail)

      const result = await service.changeEmail(
        'actual@test.com',
        'nuevo@test.com',
        'token',
      );

      expect(firebaseAuth.updateUser).toHaveBeenCalledWith('uid-1', {
        email: 'nuevo@test.com',
      });
      expect(usersService.cambiarEmail).toHaveBeenCalledWith(
        'u-1',
        'nuevo@test.com',
      );
      expect(emailSender.send).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        message: 'Correo actualizado: verificá tu nueva dirección',
        newEmail: 'nuevo@test.com',
      });
    });
  });

  describe('testEmailService', () => {
    it('usa el cache de Redis: dos llamadas seguidas devuelven el mismo link', async () => {
      firebaseAuth.generatePasswordResetLink.mockResolvedValue(
        'https://reset.link/test',
      );
      // Primer get: sin cache. Segundo (tras setex): simulamos hit.
      redisService.get
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('https://reset.link/test');

      const result = await service.testEmailService('test@test.com');

      expect(result.success).toBe(true);
      expect(result.cacheStats?.resetLinksEqual).toBe(true);
      expect(firebaseAuth.generatePasswordResetLink).toHaveBeenCalledTimes(1);
    });
  });
});
