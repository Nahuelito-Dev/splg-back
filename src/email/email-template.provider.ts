import { Injectable } from '@nestjs/common';
import { EnlacesDeLaApp } from './enlaces-de-la-app';
import { MARCA_DE_LOS_MAILS } from './marca';

/** Los valores que una plantilla interpola: todos texto, todos opcionales. */
export type DatosDePlantilla = Record<string, string | undefined>;

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
  constructor(private readonly enlaces: EnlacesDeLaApp) {}

  render(template: string, data: DatosDePlantilla): string {
    const templates: Record<string, string> = {
      welcome: `
  <!DOCTYPE html>
  <html lang="es">
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
              <div class="logo">${data.appName || MARCA_DE_LOS_MAILS}</div>
              <h2 style="color: #333; margin: 10px 0;">¡Te damos la bienvenida!</h2>
          </div>
          <div class="content">
              <p>Hola <strong>${data.displayName || 'Usuario'}</strong>,</p>
              <p>Gracias por crear tu cuenta. Ya está todo listo para que empieces a usar ${data.appName || MARCA_DE_LOS_MAILS}.</p>

              <p style="text-align: center; margin: 30px 0;">
                  <a href="${this.enlaces.inicio}" class="button" style="color: white;">Ir a la aplicación</a>
              </p>

              <p class="muted">
                ${
                  data.supportEmail
                    ? `Si necesitás ayuda, escribinos a <strong>${data.supportEmail}</strong>.`
                    : 'Si necesitás ayuda, contactá a tu distribuidora.'
                }
              </p>
          </div>
          <div class="footer">
              <p>Gracias,<br>El equipo de ${data.appName || MARCA_DE_LOS_MAILS}</p>
          </div>
      </div>
  </body>
  </html>
`,
      'email-verification': `
        <!DOCTYPE html>
        <html lang="es">
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
                    <div class="logo">${MARCA_DE_LOS_MAILS}</div>
                    <h2 style="color: #333; margin: 10px 0;">Verificá tu correo</h2>
                </div>
                <div class="content">
                    <p>Hola <strong>${data.displayName}</strong>,</p>
                    <p>¡Te damos la bienvenida a ${MARCA_DE_LOS_MAILS}! Verificá tu correo para empezar a usar tu cuenta.</p>
                    <p style="text-align: center; margin: 30px 0;">
                        <a href="${data.verificationLink}" class="button" style="color: white;">Verificar correo</a>
                    </p>
                    <p>Si el botón no funciona, copiá y pegá este enlace en el navegador:</p>
                    <p style="word-break: break-all; background: #f8f9fa; padding: 10px; border-radius: 4px; font-size: 14px;">${data.verificationLink}</p>
                    <p>Si no creaste una cuenta en ${MARCA_DE_LOS_MAILS}, ignorá este correo.</p>
                </div>
                <div class="footer">
                    <p>¡Gracias por elegir ${MARCA_DE_LOS_MAILS}!<br>Saludos,<br>El equipo de ${MARCA_DE_LOS_MAILS}</p>
                </div>
            </div>
        </body>
        </html>
      `,
      'password-reset': `
        <!DOCTYPE html>
        <html lang="es">
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
                    <div class="logo">${MARCA_DE_LOS_MAILS}</div>
                    <h2 style="color: #333; margin: 10px 0;">Restablecé tu contraseña</h2>
                </div>
                <div class="content">
                    <p>Hola,</p>
                    <p>Recibimos un pedido para restablecer la contraseña de tu cuenta de ${MARCA_DE_LOS_MAILS} (${data.email}).</p>
                    <p style="text-align: center; margin: 30px 0;">
                        <a href="${data.resetLink}" class="button" style="color: white;">Restablecer contraseña</a>
                    </p>
                    <p>Si el botón no funciona, copiá y pegá este enlace en el navegador:</p>
                    <p style="word-break: break-all; background: #f8f9fa; padding: 10px; border-radius: 4px; font-size: 14px;">${data.resetLink}</p>
                    <p>Si no pediste restablecer la contraseña, ignorá este correo: tu contraseña no se modifica.</p>
                    <p><strong>Ojo:</strong> este enlace vence en 1 hora.</p>
                </div>
                <div class="footer">
                    <p>Gracias,<br>El equipo de ${MARCA_DE_LOS_MAILS}</p>
                </div>
            </div>
        </body>
        </html>
      `,
      'email-change-notification': `
        <!DOCTYPE html>
        <html lang="es">
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
                    <div class="logo">${MARCA_DE_LOS_MAILS}</div>
                    <h2 style="color: #333; margin: 10px 0;">Cambió tu correo</h2>
                </div>
                <div class="content">
                    <p>Hola <strong>${data.displayName}</strong>,</p>
                    <p>El correo con el que ingresás a ${MARCA_DE_LOS_MAILS} se cambió de esta dirección a <strong>${data.newEmail}</strong>.</p>
                    <p>Si hiciste el cambio, no tenés que hacer nada más.</p>
                    <p>Si no pediste cambiar el correo, protegé tu cuenta ahora:</p>
                    <p style="text-align: center; margin: 30px 0;">
                        <a href="${this.enlaces.accionDeCuenta}" class="button" style="color: white;">Proteger mi cuenta</a>
                    </p>
                    <p>Si necesitás ayuda, escribile a nuestro equipo de soporte.</p>
                </div>
                <div class="footer">
                    <p>Gracias,<br>El equipo de ${MARCA_DE_LOS_MAILS}</p>
                </div>
            </div>
        </body>
        </html>
      `,
    };

    return templates[template] || '<p>Plantilla de correo inexistente</p>';
  }
}
