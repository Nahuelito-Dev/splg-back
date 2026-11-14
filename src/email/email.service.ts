import {
  Injectable,
  BadRequestException,
  HttpException,
  Logger,
} from '@nestjs/common';
import { leerConfiguracionDePlataforma } from '../common/config/plataforma.config';
import { auth } from 'firebase-admin';
import { FirebaseAuthPort } from '../firebase/ports/firebase-auth.port';
import { UsersService } from '../users/users.service';
import { RedisService } from '../redis/redis.service';
import { EmailSenderPort } from './ports/email-sender.port';
import {
  DatosDePlantilla,
  EmailTemplateProvider,
} from './email-template.provider';
import {
  EmailCambiadoResponseDto,
  PruebaDeEmailResponseDto,
} from './dto/email-response.dto';
import {
  errorCode,
  errorMessage,
  errorStatus,
} from '../common/errors/error-message';
import { EnlacesDeLaApp } from './enlaces-de-la-app';
import { MARCA_DE_LOS_MAILS } from './marca';

/** Respuesta del pedido de reseteo, exista o no la cuenta. */
const MENSAJE_DE_RESETEO =
  'Si el correo existe, te enviamos un enlace para restablecer la contraseña';

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
    private readonly usersService: UsersService,
    private readonly firebaseAuth: FirebaseAuthPort,
    private readonly redisService: RedisService,
    private readonly emailSender: EmailSenderPort,
    private readonly templates: EmailTemplateProvider,
    private readonly enlaces: EnlacesDeLaApp,
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
        'Demasiados intentos: probá de nuevo más tarde',
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
        url: this.enlaces.accionDeCuenta,
        handleCodeInApp: true,
      });

      await this.redisService.setex(cacheKey, this.CACHE_TTL_SEC, link);

      return link;
    } catch (error) {
      if (errorMessage(error).includes('TOO_MANY_ATTEMPTS_TRY_LATER')) {
        if (cached) {
          return cached;
        }

        throw new BadRequestException(
          'Demasiados intentos de recuperar la contraseña: probá de nuevo en unos minutos',
        );
      }

      // El detalle de Firebase queda en el log: al llamante no le sirve y
      // describe la configuración del proyecto (H-67).
      this.logger.error(
        `No se pudo generar el link de reseteo: ${errorMessage(error)}`,
      );
      throw new BadRequestException(
        'No se pudo generar el enlace de recuperación',
      );
    }
  }

  private async verifyIdToken(idToken: string): Promise<auth.DecodedIdToken> {
    try {
      return await this.firebaseAuth.verifyIdToken(idToken);
    } catch {
      throw new BadRequestException('Token inválido');
    }
  }

  private async updateUserEmail(uid: string, newEmail: string): Promise<void> {
    try {
      await this.firebaseAuth.updateUser(uid, { email: newEmail });
    } catch (error) {
      if (errorCode(error) === 'auth/email-already-exists') {
        throw new BadRequestException('El correo nuevo ya está en uso');
      }
      this.logger.error(
        `No se pudo actualizar el correo en Firebase: ${errorMessage(error)}`,
      );
      throw new BadRequestException('No se pudo actualizar el correo');
    }
  }

  async sendPasswordResetEmail(email: string): Promise<{ message: string }> {
    await this.checkRateLimit(email, 'password_reset');

    try {
      await this.usersService.findOneByEmail(email);
      const resetLink = await this.generatePasswordResetLink(email);

      await this.sendEmail({
        to: email,
        subject: `Restablecé tu contraseña de ${MARCA_DE_LOS_MAILS}`,
        template: 'password-reset',
        data: {
          resetLink,
          email,
          appName: MARCA_DE_LOS_MAILS,
        },
      });

      return { message: MENSAJE_DE_RESETEO };
    } catch (error) {
      // Mismo mensaje exista o no la cuenta: no se revela qué correos tienen
      // cuenta (H-68).
      if (errorStatus(error) === 404) {
        return { message: MENSAJE_DE_RESETEO };
      }
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `No se pudo enviar el correo de recuperación: ${errorMessage(error)}`,
      );
      throw new BadRequestException(
        'No se pudo enviar el correo de recuperación',
      );
    }
  }

  async changeEmail(
    currentEmail: string,
    newEmail: string,
    idToken: string,
  ): Promise<EmailCambiadoResponseDto> {
    try {
      const decodedToken = await this.verifyIdToken(idToken);

      if (decodedToken.email !== currentEmail) {
        throw new BadRequestException(
          'El token no corresponde al correo actual',
        );
      }

      try {
        await this.usersService.findOneByEmail(newEmail);
        throw new BadRequestException('El correo nuevo ya está en uso');
      } catch (error) {
        if (errorStatus(error) !== 404) throw error;
      }

      const user = await this.usersService.findOneByEmail(currentEmail);

      await this.updateUserEmail(decodedToken.uid, newEmail);

      await this.usersService.cambiarEmail(user.userId, newEmail);

      await this.sendEmailChangeNotifications(
        currentEmail,
        newEmail,
        user.fullName,
      );

      return {
        message: 'Correo actualizado: verificá tu nueva dirección',
        newEmail,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        // El usuario que no existe se informa como dato inválido, igual que siempre.
        if (error.getStatus() === 404) {
          throw new BadRequestException(error.message);
        }
        throw error;
      }
      this.logger.error(`No se pudo cambiar el correo: ${errorMessage(error)}`);
      throw new BadRequestException('No se pudo cambiar el correo');
    }
  }

  private async sendEmailChangeNotifications(
    oldEmail: string,
    newEmail: string,
    displayName?: string,
  ): Promise<void> {
    await this.sendEmail({
      to: newEmail,
      subject: `Verificá tu correo de ${MARCA_DE_LOS_MAILS}`,
      template: 'email-verification',
      data: {
        displayName: displayName || 'Usuario',
        appName: MARCA_DE_LOS_MAILS,
      },
    });

    await this.sendEmail({
      to: oldEmail,
      subject: `Cambió el correo de ingreso a ${MARCA_DE_LOS_MAILS}`,
      template: 'email-change-notification',
      data: {
        displayName: displayName || 'Usuario',
        newEmail,
        appName: MARCA_DE_LOS_MAILS,
      },
    });
  }

  private async sendEmail(emailData: {
    to: string;
    subject: string;
    template: string;
    data: DatosDePlantilla;
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
        `No se pudo enviar el email "${emailData.subject}" a ${emailData.to}: ${errorMessage(error)}`,
      );
    }
  }

  async sendWelcomeEmail(email: string, displayName: string): Promise<void> {
    try {
      await this.sendEmail({
        to: email,
        subject: `Te damos la bienvenida a ${MARCA_DE_LOS_MAILS}`,
        template: 'welcome',
        data: {
          displayName,
          appName: MARCA_DE_LOS_MAILS,
          supportEmail:
            leerConfiguracionDePlataforma(process.env).supportEmail ??
            undefined,
        },
      });
    } catch (error) {
      // Best-effort: el alta ya está confirmada; un correo que no sale sólo
      // deja rastro.
      this.logger.warn(
        `Falló el envío del welcome email a ${email}: ${errorMessage(error)}`,
      );
    }
  }

  async testEmailService(email: string): Promise<PruebaDeEmailResponseDto> {
    try {
      const resetLink1 = await this.generatePasswordResetLink(email);
      const resetLink2 = await this.generatePasswordResetLink(email);

      let emailSent = false;
      let resendStatus = 'not_attempted';

      try {
        await this.sendEmail({
          to: email,
          subject: `Correo de prueba de ${MARCA_DE_LOS_MAILS}`,
          template: 'email-verification',
          data: {
            displayName: 'Usuario de prueba',
            appName: MARCA_DE_LOS_MAILS,
          },
        });

        emailSent = true;
        resendStatus = 'sent';
      } catch (emailError) {
        this.logger.warn(
          `El servicio de correo falló en la prueba: ${errorMessage(emailError)}`,
        );
        resendStatus = `failed: ${errorMessage(emailError)}`;
      }

      return {
        success: true,
        message: 'El servicio de correo funciona correctamente',
        emailSent,
        resendStatus,
        cacheStats: {
          cacheEnabled: true,
          resetLinksEqual: resetLink1 === resetLink2,
        },
      };
    } catch (error) {
      this.logger.error(
        `Falló la prueba del servicio de correo: ${errorMessage(error)}`,
      );
      return {
        success: false,
        message: 'El servicio de correo falló',
      };
    }
  }
}
