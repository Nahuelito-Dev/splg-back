import { Injectable } from '@nestjs/common';
import { AdminService } from '../../admin/admin.service';
import { EmailSenderPort } from '../../email/ports/email-sender.port';

/** Avisos por email a los administradores de una distribuidora. */
@Injectable()
export class StockAdminNotifier {
  constructor(
    private readonly admins: AdminService,
    private readonly emailSender: EmailSenderPort,
  ) {}

  /**
   * Manda el aviso a cada administrador con email. Devuelve `false` si no hay a
   * quién avisarle. Si el envío falla, rechaza: quien llama decide no marcar el
   * aviso como hecho para reintentarlo en la próxima corrida.
   */
  async avisar(
    distributorId: string,
    subject: string,
    html: string,
  ): Promise<boolean> {
    const admins = await this.admins.findAll(distributorId);
    const destinatarios = admins
      .map((a) => a.user?.email)
      .filter((email): email is string => Boolean(email));
    if (destinatarios.length === 0) return false;
    await Promise.all(
      destinatarios.map((to) => this.emailSender.send({ to, subject, html })),
    );
    return true;
  }
}

export function escaparHtml(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
