import {
  Injectable,
  BadRequestException,
  forwardRef,
  Inject,
  Logger,
} from '@nestjs/common';
import { auth } from 'firebase-admin';
import { FirebaseAuthPort } from '../firebase/ports/firebase-auth.port';
import { UsersService } from '../users/users.service';
import { RedisService } from '../redis/redis.service';
import { EmailSenderPort } from './ports/email-sender.port';
import { EmailTemplateProvider } from './email-template.provider';

/**
 * Orquestador de emails transaccionales (reset de password, cambio de
 * email, welcome). Ya NO conoce el SDK de Resend (habla contra
 * `EmailSenderPort`) ni carga con el HTML de los templates (delegado a
 * `EmailTemplateProvider`).
 *
 * Rate-limit y cache de links viven en Redis (vía `RedisService`), no en
 * `Map`s en memoria del proceso: antes, con más de una instancia corriendo,
 * cada pod tenía su propio estado y el rate-limit real era
 * `MAX_REQUESTS_PER_HOUR * cantidad_de_pods`. Con Redis el estado es
 * compartido y el TTL lo maneja Redis solo (no hace falta un `setInterval`
 * de limpieza).
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  /** TTL del cache de links de reset (segundos). Mismo valor que el TTL en memoria original (30 min). */
  private readonly CACHE_TTL_SEC = 30 * 60;

  /** Ventana y tope del rate-limit por email+operación. Mismos valores que el tracker en memoria original. */
  private readonly MAX_REQUESTS_PER_WINDOW = 10;
  private readonly TRACKING_WINDOW_SEC = 60 * 60;

  constructor(
    @Inject(forwardRef(() => UsersService))
    private readonly usersService: UsersService,
    private readonly firebaseAuth: FirebaseAuthPort,
    private readonly redisService: RedisService,
    private readonly emailSender: EmailSenderPort,
    private readonly templates: EmailTemplateProvider,
  ) {}

  private async checkRateLimit(
    email: string,
    operation: string,
  ): Promise<void> {
    const key = `email:ratelimit:${email}:${operation}`;
    const count = await this.redisService.incrWithExpire(
      key,
      this.TRACKING_WINDOW_SEC,
    );

    if (count > this.MAX_REQUESTS_PER_WINDOW) {
      throw new BadRequestException(
        `Too many ${operation} attempts. Please try again later.`,
      );
    }
  }

  private linkCacheKey(email: string): string {
    return `email:link-cache:reset:${email}`;
  }

  private async generatePasswordResetLink(email: string): Promise<string> {
    const cacheKey = this.linkCacheKey(email);
    const cached = await this.redisService.get(cacheKey);

    if (cached) {
      return cached;
    }

    try {
      const link = await this.firebaseAuth.generatePasswordResetLink(email, {
        url: 'https://taolistic-courses.firebaseapp.com/__/auth/action',
        handleCodeInApp: true,
      });

      await this.redisService.setex(cacheKey, this.CACHE_TTL_SEC, link);

      return link;
    } catch (error) {
      if (error.message.includes('TOO_MANY_ATTEMPTS_TRY_LATER')) {
        if (cached) {
          return cached;
        }

        throw new BadRequestException(
          'Too many password reset attempts. Please try again in a few minutes.',
        );
      }

      throw new BadRequestException(
        `Error generating reset link: ${error.message}`,
      );
    }
  }

  private async verifyIdToken(
    idToken: string,
  ): Promise<auth.DecodedIdToken> {
    try {
      return await this.firebaseAuth.verifyIdToken(idToken);
    } catch (error) {
      throw new BadRequestException('Invalid token');
    }
  }

  private async updateUserEmail(uid: string, newEmail: string): Promise<void> {
    try {
      await this.firebaseAuth.updateUser(uid, { email: newEmail });
    } catch (error) {
      throw new BadRequestException(`Error updating email: ${error.message}`);
    }
  }

  async sendPasswordResetEmail(email: string): Promise<{ message: string }> {
    await this.checkRateLimit(email, 'password_reset');

    try {
      await this.usersService.findOneByEmail(email);
      const resetLink = await this.generatePasswordResetLink(email);

      await this.sendEmail({
        to: email,
        subject: `Reset your password for Yeni Gass`,
        template: 'password-reset',
        data: {
          resetLink,
          email,
          appName: 'Yeni Gass',
        },
      });

      return { message: 'Password reset email sent successfully' };
    } catch (error) {
      if (error.status === 404) {
        return {
          message: 'If the email exists, a password reset link has been sent',
        };
      }
      throw new BadRequestException(error.message);
    }
  }

  async changeEmail(
    currentEmail: string,
    newEmail: string,
    idToken: string,
  ): Promise<{ message: string; newEmail: string }> {
    try {
      const decodedToken = await this.verifyIdToken(idToken);

      if (decodedToken.email !== currentEmail) {
        throw new BadRequestException('Token does not match current email');
      }

      try {
        await this.usersService.findOneByEmail(newEmail);
        throw new BadRequestException('New email already exists');
      } catch (error) {
        if (error.status !== 404) throw error;
      }

      const user = await this.usersService.findOneByEmail(currentEmail);

      await this.updateUserEmail(decodedToken.uid, newEmail);

      await this.usersService.update(user.user_id, {
        email: newEmail,
        email_verified: false,
      });

      await this.sendEmailChangeNotifications(
        currentEmail,
        newEmail,
        user.full_name,
      );

      return {
        message:
          'Email changed successfully. Please verify your new email address.',
        newEmail,
      };
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  private async sendEmailChangeNotifications(
    oldEmail: string,
    newEmail: string,
    displayName?: string,
  ): Promise<void> {
    try {
      await this.sendEmail({
        to: newEmail,
        subject: `Verify your email for Yeni Gass`,
        template: 'email-verification',
        data: {
          displayName: displayName || 'User',
          appName: 'Yeni Gass',
        },
      });

      await this.sendEmail({
        to: oldEmail,
        subject: `Your sign-in email was changed for Yeni Gass`,
        template: 'email-change-notification',
        data: {
          displayName: displayName || 'User',
          newEmail,
          appName: 'Yeni Gass',
        },
      });
    } catch (error) {
      throw error;
    }
  }

  private async sendEmail(emailData: {
    to: string;
    subject: string;
    template: string;
    data: any;
  }): Promise<void> {
    try {
      const html = this.templates.render(emailData.template, emailData.data);

      await this.emailSender.send({
        to: emailData.to,
        subject: emailData.subject,
        html,
      });
    } catch (error) {
      // Best-effort: el envío de email nunca debe tumbar el flujo que lo
      // dispara (registro, cambio de contraseña, etc). Solo dejamos rastro.
      this.logger.warn(
        `No se pudo enviar el email "${emailData.subject}" a ${emailData.to}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  async sendWelcomeEmail(email: string): Promise<void> {
    try {
      let displayName = 'User';
      try {
        const user = await this.usersService.findOneByEmail(email);
        displayName = user.full_name || 'User';
      } catch (error) {
        // Best-effort: si no se encuentra el usuario igual mandamos el
        // welcome email con un displayName genérico.
        this.logger.warn(
          `No se pudo resolver el nombre del usuario ${email} para el welcome email: ${error instanceof Error ? error.message : error}`,
        );
      }

      await this.sendEmail({
        to: email,
        subject: `Welcome to Yeni Gass`,
        template: 'welcome',
        data: {
          displayName,
          appName: 'Yeni Gass',
          supportEmail: 'support@wagnerlabs.dev',
        },
      });
    } catch (error) {
      // Best-effort: el welcome email nunca debe interrumpir el flujo que lo
      // dispara (createCustomerWithUser). Solo dejamos rastro.
      this.logger.warn(
        `Falló el envío del welcome email a ${email}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  async testEmailService(email: string): Promise<{
    success: boolean;
    message: string;
    cacheStats?: any;
    emailSent?: boolean;
    resendStatus?: string;
  }> {
    try {
      const resetLink1 = await this.generatePasswordResetLink(email);
      const resetLink2 = await this.generatePasswordResetLink(email);

      let emailSent = false;
      let resendStatus = 'not_attempted';

      try {
        await this.sendEmail({
          to: email,
          subject: `Test Email from Yeni Gass`,
          template: 'email-verification',
          data: {
            displayName: 'Test User',
            appName: 'Yeni Gass',
          },
        });

        emailSent = true;
        resendStatus = 'sent';
      } catch (emailError) {
        resendStatus = `failed: ${emailError.message}`;
      }

      return {
        success: true,
        message: 'Email service is working correctly',
        emailSent,
        resendStatus,
        cacheStats: {
          cacheEnabled: true,
          resetLinksEqual: resetLink1 === resetLink2,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: `Email service test failed: ${error.message}`,
      };
    }
  }
}
