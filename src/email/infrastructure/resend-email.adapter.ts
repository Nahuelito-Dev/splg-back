import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import {
  NotificationChannel,
  NotificationStatus,
} from '../../notification-log/domain/aviso';
import { NotificationLogRecorder } from '../../notification-log/notification-log.recorder';
import { MARCA_DE_LOS_MAILS } from '../marca';
import { EmailSenderPort, SendEmailInput } from '../ports/email-sender.port';
import {
  destinoDeRedireccion,
  redirigirCorreo,
} from '../redireccion-de-desarrollo';

/**
 * Remitente por omisión: el de prueba de Resend, que sólo entrega al correo
 * dueño de la cuenta. En producción se configura `EMAIL_FROM` con un dominio
 * verificado en Resend (p. ej. `OrixTech <noreply@dominio>`).
 */
export const REMITENTE_POR_OMISION = `${MARCA_DE_LOS_MAILS} <onboarding@resend.dev>`;

/**
 * Adapter del EmailSenderPort sobre el SDK de Resend. Único lugar del
 * dominio que conoce `resend`: el resto del módulo (EmailService) habla
 * contra el puerto.
 *
 * Si no hay `RESEND_API_KEY` configurada (ej. dev/test), el cliente queda
 * sin inicializar y `send` resuelve sin hacer nada — mismo comportamiento
 * que tenía `EmailService` antes del refactor.
 *
 * Con `EMAIL_REDIRECT_TO` (y fuera de producción) todo correo sale hacia esa
 * dirección, marcado con su destinatario original (`redirigirCorreo`).
 */
@Injectable()
export class ResendEmailAdapter extends EmailSenderPort {
  private readonly resend: Resend | null;
  private readonly remitente: string;
  private readonly redireccion: string | null;
  private readonly logger = new Logger(ResendEmailAdapter.name);

  constructor(
    private readonly config: ConfigService,
    private readonly registro: NotificationLogRecorder,
  ) {
    super();
    const resendApiKey = this.config.get<string>('RESEND_API_KEY');
    this.resend = resendApiKey ? new Resend(resendApiKey) : null;
    this.remitente =
      this.config.get<string>('EMAIL_FROM')?.trim() || REMITENTE_POR_OMISION;
    this.redireccion = destinoDeRedireccion({
      NODE_ENV: this.config.get<string>('NODE_ENV'),
      EMAIL_REDIRECT_TO: this.config.get<string>('EMAIL_REDIRECT_TO'),
    });
    if (this.redireccion) {
      this.logger.warn(
        `EMAIL_REDIRECT_TO activo: todos los correos van a ${this.redireccion}`,
      );
    }
  }

  async send(input: SendEmailInput): Promise<void> {
    await this.registro.conRegistro(
      {
        channel: NotificationChannel.EMAIL,
        destino: input.to,
        titulo: input.subject,
        contexto: input.registro,
      },
      () => this.enviar(input),
      (enviado) =>
        enviado
          ? null
          : {
              status: NotificationStatus.SKIPPED,
              error:
                'El envío de correo no está configurado (sin RESEND_API_KEY)',
            },
    );
  }

  /** `false` si no hay cliente de correo configurado y no se mandó nada. */
  private async enviar(input: SendEmailInput): Promise<boolean> {
    if (!this.resend) {
      return false;
    }

    const { to, subject, html, text } = this.redireccion
      ? redirigirCorreo(input, this.redireccion)
      : input;
    const result = await this.resend.emails.send({
      from: this.remitente,
      to,
      subject,
      html,
      ...(text !== undefined ? { text } : {}),
    });

    if (result.error) {
      throw new Error(result.error.message);
    }
    return true;
  }
}
