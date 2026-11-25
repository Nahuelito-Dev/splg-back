import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AdminService } from '../admin/admin.service';
import { errorMessage } from '../common/errors/error-message';
import {
  EVENTO_NOTIFICAR_ADMIN,
  NotificarAdminEvent,
} from '../common/events/notificar-admin.event';
import { EmailSenderPort } from '../email/ports/email-sender.port';
import { EnlacesDeLaApp } from '../email/enlaces-de-la-app';
import { MarcasDeCorreo } from '../email/marcas-de-correo.service';
import { AdminGateway } from '../gateways/admin.gateway';
import { AdminNotificationMapper } from './admin-notifications.mapper';
import { AdminNotificationsService } from './admin-notifications.service';
import { correoDelAviso, rutaDelPanelDelAviso } from './aviso-por-correo';
import { AdminNotification } from './entities/admin-notification.entity';

/** Evento del socket del panel con cada aviso nuevo de la bandeja. */
export const EVENTO_AVISO_EN_VIVO = 'admin:notification';

/**
 * Entrega los pedidos de aviso a los administradores: los guarda en la
 * bandeja, los empuja por el socket y, si el aviso lo pide, manda el correo.
 * Es best-effort: un error se registra y nunca llega a quien emitió el evento.
 */
@Injectable()
export class AdminNotificationsListener {
  private readonly logger = new Logger(AdminNotificationsListener.name);

  constructor(
    private readonly bandeja: AdminNotificationsService,
    private readonly gateway: AdminGateway,
    private readonly admins: AdminService,
    private readonly emailSender: EmailSenderPort,
    private readonly enlaces: EnlacesDeLaApp,
    private readonly marcas: MarcasDeCorreo,
  ) {}

  @OnEvent(EVENTO_NOTIFICAR_ADMIN, { async: true })
  async handle(evento: NotificarAdminEvent): Promise<void> {
    try {
      const aviso = await this.bandeja.registrar(evento);
      // Repetido: ni socket ni correo, ya se avisó la primera vez.
      if (!aviso) return;
      this.empujarAlPanel(aviso);
      if (aviso.email) await this.enviarCorreos(aviso);
    } catch (error) {
      this.logger.warn(
        `No se pudo entregar el aviso ${evento.kind} (${evento.dedupeKey}): ${errorMessage(error)}`,
      );
    }
  }

  private empujarAlPanel(aviso: AdminNotification): void {
    try {
      // Un aviso para una persona: sólo a sus conexiones, nunca a la sala de la empresa.
      if (aviso.recipientUserId) {
        this.gateway.emitirAUsuario(
          aviso.recipientUserId,
          EVENTO_AVISO_EN_VIVO,
          AdminNotificationMapper.toLiveDto(aviso),
        );
        return;
      }
      this.gateway.notifyAdmins(
        EVENTO_AVISO_EN_VIVO,
        AdminNotificationMapper.toLiveDto(aviso),
        aviso.distributorId,
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo emitir el aviso ${aviso.notificationId} por el socket: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Un correo por admin activo; si uno falla se registra y no se reintenta. Los
   * avisos de la plataforma y los dirigidos a una persona no van por correo:
   * quedan en la bandeja.
   */
  private async enviarCorreos(aviso: AdminNotification): Promise<void> {
    if (!aviso.distributorId || aviso.recipientUserId) return;
    const destinatarios = await this.admins.emailsDeAdminsActivos(
      aviso.distributorId,
    );
    if (destinatarios.length === 0) return;

    const ruta = rutaDelPanelDelAviso(aviso);
    // El asunto sale en una sola línea (lo asegura el layout): un salto no se cuela como cabecera.
    const correo = correoDelAviso(
      aviso,
      ruta === null ? null : this.enlaces.panel(ruta),
      await this.marcas.deDistribuidora(aviso.distributorId),
    );
    const resultados = await Promise.allSettled(
      destinatarios.map((to) =>
        this.emailSender.send({
          to,
          subject: correo.asunto,
          html: correo.html,
          text: correo.text,
          registro: {
            type: 'ADMIN_NOTIFICATION',
            distributorId: aviso.distributorId,
          },
        }),
      ),
    );
    let enviados = 0;
    for (const resultado of resultados) {
      if (resultado.status === 'fulfilled') enviados += 1;
      else
        this.logger.warn(
          `No se pudo mandar el correo del aviso ${aviso.notificationId}: ${errorMessage(resultado.reason)}`,
        );
    }
    if (enviados > 0) await this.bandeja.marcarCorreoEnviado(aviso);
  }
}
