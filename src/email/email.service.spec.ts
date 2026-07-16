import { BadRequestException } from '@nestjs/common';
import { EmailService } from './email.service';

/**
 * EmailService, orquestador SIN el SDK de Resend ni Maps en memoria:
 * `EmailSenderPort` y `RedisService` van mockeados (nunca contra Redis/Resend
 * real). Foco de estos tests: que el rate-limit y el cache de links pasen
 * por Redis (no por estado en memoria del proceso) y que los emails sigan
 * siendo best-effort (un fallo del sender nunca revienta el flujo).
 */
describe('EmailService', () => {
  let service: EmailService;
  let usersService: { findOneByEmail: jest.Mock; update: jest.Mock };
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
  let templates: { render: jest.Mock };

  beforeEach(() => {
    usersService = {
      findOneByEmail: jest.fn(),
      update: jest.fn(),
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
    templates = { render: jest.fn().mockReturnValue('<p>html</p>') };

    service = new EmailService(
      usersService as any,
      firebaseAuth as any,
      redisService as any,
      emailSender as any,
      templates as any,
    );
  });

  describe('sendPasswordResetEmail', () => {
    it('chequea el rate-limit contra Redis con la key email:ratelimit:<email>:password_reset', async () => {
      usersService.findOneByEmail.mockResolvedValue({ user_id: 'u-1' });
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
      usersService.findOneByEmail.mockResolvedValue({ user_id: 'u-1' });
      redisService.get.mockResolvedValue('https://reset.link/cached');

      const result = await service.sendPasswordResetEmail('cliente@test.com');

      expect(firebaseAuth.generatePasswordResetLink).not.toHaveBeenCalled();
      expect(emailSender.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'cliente@test.com' }),
      );
      expect(result).toEqual({
        message: 'Password reset email sent successfully',
      });
    });

    it('cachea el link nuevo en Redis con TTL de 30 minutos', async () => {
      usersService.findOneByEmail.mockResolvedValue({ user_id: 'u-1' });
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

    it('usuario inexistente: responde genérico (no filtra si el email existe)', async () => {
      const notFound: any = new Error('not found');
      notFound.status = 404;
      usersService.findOneByEmail.mockRejectedValue(notFound);

      const result = await service.sendPasswordResetEmail('nadie@test.com');

      expect(result).toEqual({
        message: 'If the email exists, a password reset link has been sent',
      });
    });

    it('el envío de email es best-effort: si el sender falla, igual devuelve éxito', async () => {
      usersService.findOneByEmail.mockResolvedValue({ user_id: 'u-1' });
      firebaseAuth.generatePasswordResetLink.mockResolvedValue(
        'https://reset.link/1',
      );
      emailSender.send.mockRejectedValue(new Error('Resend caído'));

      const result = await service.sendPasswordResetEmail('cliente@test.com');

      expect(result).toEqual({
        message: 'Password reset email sent successfully',
      });
    });
  });

  describe('sendWelcomeEmail', () => {
    it('best-effort: si el usuario no se encuentra, igual manda el welcome con nombre genérico y no revienta', async () => {
      usersService.findOneByEmail.mockRejectedValue(new Error('no user'));

      await expect(
        service.sendWelcomeEmail('nuevo@test.com'),
      ).resolves.toBeUndefined();

      expect(emailSender.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'nuevo@test.com' }),
      );
    });

    it('best-effort: si el sender falla, no propaga la excepción', async () => {
      usersService.findOneByEmail.mockResolvedValue({ full_name: 'Nahuel' });
      emailSender.send.mockRejectedValue(new Error('Resend caído'));

      await expect(
        service.sendWelcomeEmail('nuevo@test.com'),
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

    it('flujo feliz: actualiza Firebase + usersService y notifica ambos emails', async () => {
      firebaseAuth.verifyIdToken.mockResolvedValue({
        email: 'actual@test.com',
        uid: 'uid-1',
      });
      const notFound: any = new Error('not found');
      notFound.status = 404;
      usersService.findOneByEmail
        .mockRejectedValueOnce(notFound) // check newEmail no existe
        .mockResolvedValueOnce({ user_id: 'u-1', full_name: 'Nahuel' }); // findOneByEmail(currentEmail)

      const result = await service.changeEmail(
        'actual@test.com',
        'nuevo@test.com',
        'token',
      );

      expect(firebaseAuth.updateUser).toHaveBeenCalledWith('uid-1', {
        email: 'nuevo@test.com',
      });
      expect(usersService.update).toHaveBeenCalledWith('u-1', {
        email: 'nuevo@test.com',
        email_verified: false,
      });
      expect(emailSender.send).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        message:
          'Email changed successfully. Please verify your new email address.',
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
      expect(result.cacheStats.resetLinksEqual).toBe(true);
      expect(firebaseAuth.generatePasswordResetLink).toHaveBeenCalledTimes(1);
    });
  });
});
