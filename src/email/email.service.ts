import {
  Injectable,
  BadRequestException,
  forwardRef,
  Inject,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { auth } from 'firebase-admin';
import { FirebaseAuthPort } from '../firebase/ports/firebase-auth.port';
import { UsersService } from '../users/users.service';
import { Resend } from 'resend';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private resend: Resend;

  private linkCache = new Map<
    string,
    {
      link: string;
      timestamp: number;
      type: 'verification' | 'reset';
    }
  >();
  private readonly CACHE_TTL = 30 * 60 * 1000;

  private requestTracker = new Map<string, number[]>();
  private readonly MAX_REQUESTS_PER_HOUR = 10;
  private readonly TRACKING_WINDOW = 60 * 60 * 1000;

  constructor(
    private readonly config: ConfigService,
    @Inject(forwardRef(() => UsersService))
    private readonly usersService: UsersService,
    private readonly firebaseAuth: FirebaseAuthPort,
  ) {
    const resendApiKey = this.config.get('RESEND_API_KEY');
    if (resendApiKey) {
      this.resend = new Resend(resendApiKey);
    }

    setInterval(() => this.cleanupCache(), 60 * 60 * 1000);
    setInterval(() => this.cleanupRequestTracker(), 60 * 60 * 1000);
  }

  private cleanupCache() {
    const now = Date.now();
    for (const [key, value] of this.linkCache.entries()) {
      if (now - value.timestamp > this.CACHE_TTL) {
        this.linkCache.delete(key);
      }
    }
  }

  private cleanupRequestTracker() {
    const now = Date.now();
    const windowStart = now - this.TRACKING_WINDOW;

    for (const [key, timestamps] of this.requestTracker.entries()) {
      const recentRequests = timestamps.filter((time) => time > windowStart);
      if (recentRequests.length === 0) {
        this.requestTracker.delete(key);
      } else {
        this.requestTracker.set(key, recentRequests);
      }
    }
  }

  private checkRateLimit(email: string, operation: string): void {
    const key = `${operation}:${email}`;
    const now = Date.now();
    const windowStart = now - this.TRACKING_WINDOW;

    if (!this.requestTracker.has(key)) {
      this.requestTracker.set(key, []);
    }

    const timestamps = this.requestTracker.get(key)!;

    const recentRequests = timestamps.filter((time) => time > windowStart);
    this.requestTracker.set(key, recentRequests);

    if (recentRequests.length >= this.MAX_REQUESTS_PER_HOUR) {
      throw new BadRequestException(
        `Too many ${operation} attempts. Please try again later.`,
      );
    }

    recentRequests.push(now);
  }

  private async generatePasswordResetLink(email: string): Promise<string> {
    const cacheKey = `reset:${email}`;
    const cached = this.linkCache.get(cacheKey);

    if (cached && cached.type === 'reset') {
      return cached.link;
    }

    try {
      const link = await this.firebaseAuth.generatePasswordResetLink(email, {
        url: 'https://taolistic-courses.firebaseapp.com/__/auth/action',
        handleCodeInApp: true,
      });

      this.linkCache.set(cacheKey, {
        link,
        timestamp: Date.now(),
        type: 'reset',
      });

      return link;
    } catch (error) {
      if (error.message.includes('TOO_MANY_ATTEMPTS_TRY_LATER')) {
        if (cached) {
          return cached.link;
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
    this.checkRateLimit(email, 'password_reset');

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
      if (!this.resend) {
        return;
      }

      const htmlContent = this.generateEmailTemplate(
        emailData.template,
        emailData.data,
      );

      const result = await this.resend.emails.send({
        from: 'Yeni Gass <noreply@wagnerlabs.dev>',
        to: emailData.to,
        subject: emailData.subject,
        html: htmlContent,
      });

      if (result.error) {
        throw new Error(result.error.message);
      }
    } catch (error) {
      // Best-effort: el envío de email nunca debe tumbar el flujo que lo
      // dispara (registro, cambio de contraseña, etc). Solo dejamos rastro.
      this.logger.warn(
        `No se pudo enviar el email "${emailData.subject}" a ${emailData.to}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private generateEmailTemplate(template: string, data: any): string {
    const templates = {
      welcome: `
  <!DOCTYPE html>
  <html>
  <head>
      <meta charset="utf-8">
      <style>
          body { font-family: 'Arial', sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f9f9f9; }
          .container { max-width: 600px; margin: 0 auto; background: #ffffff; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); }
          .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #28a745; padding-bottom: 20px; }
          .logo { font-size: 24px; font-weight: bold; color: #28a745; margin-bottom: 10px; }
          .content { line-height: 1.8; }
          .button { display: inline-block; padding: 14px 28px; background-color: #28a745; color: white; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eaeaea; text-align: center; color: #666; font-size: 14px; }
          .muted { color: #6c757d; font-size: 14px; }
      </style>
  </head>
  <body>
      <div class="container">
          <div class="header">
              <div class="logo">${data.appName || 'Yeni Gass'}</div>
              <h2 style="color: #333; margin: 10px 0;">Welcome!</h2>
          </div>
          <div class="content">
              <p>Hello <strong>${data.displayName || 'User'}</strong>,</p>
              <p>Thanks for creating your account. You’re all set and can start using ${data.appName || 'Yeni Gass'} right away.</p>

              <p style="text-align: center; margin: 30px 0;">
                  <a href="https://taolistic-courses.firebaseapp.com/" class="button" style="color: white;">Go to the app</a>
              </p>

              <p class="muted">
                If you need help, reply to this email or contact us at
                <strong>${data.supportEmail || 'support@wagnerlabs.dev'}</strong>.
              </p>
          </div>
          <div class="footer">
              <p>Thanks,<br>The ${data.appName || 'Yeni Gass'} Team</p>
          </div>
      </div>
  </body>
  </html>
`,
      'email-verification': `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <style>
                body { font-family: 'Arial', sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f9f9f9; }
                .container { max-width: 600px; margin: 0 auto; background: #ffffff; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); }
                .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #007bff; padding-bottom: 20px; }
                .button { display: inline-block; padding: 14px 28px; background-color: #007bff; color: white; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px; }
                .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eaeaea; text-align: center; color: #666; font-size: 14px; }
                .logo { font-size: 24px; font-weight: bold; color: #007bff; margin-bottom: 10px; }
                .content { line-height: 1.8; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <div class="logo">Yeni Gass</div>
                    <h2 style="color: #333; margin: 10px 0;">Verify Your Email Address</h2>
                </div>
                <div class="content">
                    <p>Hello <strong>${data.displayName}</strong>,</p>
                    <p>Welcome to Yeni Gass! Please verify your email address to get started with your account.</p>
                    <p style="text-align: center; margin: 30px 0;">
                        <a href="${data.verificationLink}" class="button" style="color: white;">Verify Email Address</a>
                    </p>
                    <p>If the button doesn't work, copy and paste this link in your browser:</p>
                    <p style="word-break: break-all; background: #f8f9fa; padding: 10px; border-radius: 4px; font-size: 14px;">${data.verificationLink}</p>
                    <p>If you didn't create an account with Yeni Gass, you can safely ignore this email.</p>
                </div>
                <div class="footer">
                    <p>Thanks for choosing Yeni Gass!<br>Best regards,<br>The Taolistic Team</p>
                </div>
            </div>
        </body>
        </html>
      `,
      'password-reset': `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <style>
                body { font-family: 'Arial', sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f9f9f9; }
                .container { max-width: 600px; margin: 0 auto; background: #ffffff; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); }
                .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #dc3545; padding-bottom: 20px; }
                .button { display: inline-block; padding: 14px 28px; background-color: #dc3545; color: white; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px; }
                .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eaeaea; text-align: center; color: #666; font-size: 14px; }
                .logo { font-size: 24px; font-weight: bold; color: #dc3545; margin-bottom: 10px; }
                .content { line-height: 1.8; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <div class="logo">Yeni Gass</div>
                    <h2 style="color: #333; margin: 10px 0;">Reset Your Password</h2>
                </div>
                <div class="content">
                    <p>Hello,</p>
                    <p>We received a request to reset your password for your Yeni Gass account (${data.email}).</p>
                    <p style="text-align: center; margin: 30px 0;">
                        <a href="${data.resetLink}" class="button" style="color: white;">Reset Password</a>
                    </p>
                    <p>If the button doesn't work, copy and paste this link in your browser:</p>
                    <p style="word-break: break-all; background: #f8f9fa; padding: 10px; border-radius: 4px; font-size: 14px;">${data.resetLink}</p>
                    <p>If you didn't request a password reset, you can safely ignore this email. Your password will not be changed.</p>
                    <p><strong>Note:</strong> This password reset link will expire in 1 hour.</p>
                </div>
                <div class="footer">
                    <p>Thanks,<br>The Yeni Gass Team</p>
                </div>
            </div>
        </body>
        </html>
      `,
      'email-change-notification': `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <style>
                body { font-family: 'Arial', sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f9f9f9; }
                .container { max-width: 600px; margin: 0 auto; background: #ffffff; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); }
                .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #6c757d; padding-bottom: 20px; }
                .button { display: inline-block; padding: 14px 28px; background-color: #6c757d; color: white; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px; }
                .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eaeaea; text-align: center; color: #666; font-size: 14px; }
                .logo { font-size: 24px; font-weight: bold; color: #6c757d; margin-bottom: 10px; }
                .content { line-height: 1.8; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <div class="logo">Yeni Gass</div>
                    <h2 style="color: #333; margin: 10px 0;">Email Address Changed</h2>
                </div>
                <div class="content">
                    <p>Hello <strong>${data.displayName}</strong>,</p>
                    <p>Your sign-in email for Yeni Gass was changed from this address to <strong>${data.newEmail}</strong>.</p>
                    <p>If you made this change, no further action is required.</p>
                    <p>If you didn't ask to change your email, please secure your account immediately:</p>
                    <p style="text-align: center; margin: 30px 0;">
                        <a href="https://taolistic-courses.firebaseapp.com/__/auth/action" class="button" style="color: white;">Secure Your Account</a>
                    </p>
                    <p>If you need assistance, please contact our support team.</p>
                </div>
                <div class="footer">
                    <p>Thanks,<br>The Yeni Gass Team</p>
                </div>
            </div>
        </body>
        </html>
      `,
    };

    return templates[template] || '<p>Email template not found</p>';
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
          cacheSize: this.linkCache.size,
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
