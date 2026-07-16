import { Injectable } from '@nestjs/common';

/**
 * Provider de templates de email. Antes vivían embebidos (~250 líneas de
 * HTML inline) dentro de `EmailService.generateEmailTemplate`; se movieron
 * acá para que EmailService quede como orquestador (rate-limit → link/token
 * → template → send) sin cargar con el marcado.
 *
 * `render` mantiene el mismo contrato y fallback que el método original:
 * si el template no existe, devuelve el mismo placeholder.
 */
@Injectable()
export class EmailTemplateProvider {
  render(template: string, data: any): string {
    const templates: Record<string, string> = {
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
}
