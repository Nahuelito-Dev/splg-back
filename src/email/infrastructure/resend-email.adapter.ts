import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { MARCA_DE_LOS_MAILS } from '../marca';
import { EmailSenderPort, SendEmailInput } from '../ports/email-sender.port';

const FROM_ADDRESS = `${MARCA_DE_LOS_MAILS} <noreply@wagnerlabs.dev>`;

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

  constructor(private readonly config: ConfigService) {
    super();
    const resendApiKey = this.config.get<string>('RESEND_API_KEY');
    this.resend = resendApiKey ? new Resend(resendApiKey) : null;
  }

  async send({ to, subject, html }: SendEmailInput): Promise<void> {
    if (!this.resend) {
      return;
    }

    const result = await this.resend.emails.send({
      from: FROM_ADDRESS,
      to,
      subject,
      html,
    });

    if (result.error) {
      throw new Error(result.error.message);
    }
  }
}
