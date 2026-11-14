import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { MARCA_DE_LOS_MAILS } from '../marca';
import { EmailSenderPort, SendEmailInput } from '../ports/email-sender.port';

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
 */
@Injectable()
export class ResendEmailAdapter extends EmailSenderPort {
  private readonly resend: Resend | null;
  private readonly remitente: string;

  constructor(private readonly config: ConfigService) {
    super();
    const resendApiKey = this.config.get<string>('RESEND_API_KEY');
    this.resend = resendApiKey ? new Resend(resendApiKey) : null;
    this.remitente =
      this.config.get<string>('EMAIL_FROM')?.trim() || REMITENTE_POR_OMISION;
  }

  async send({ to, subject, html }: SendEmailInput): Promise<void> {
    if (!this.resend) {
      return;
    }

    const result = await this.resend.emails.send({
      from: this.remitente,
      to,
      subject,
      html,
    });

    if (result.error) {
      throw new Error(result.error.message);
    }
  }
}
