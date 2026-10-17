import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { errorMessage } from '../../common/errors/error-message';
import { AdminGateway } from '../../gateways/admin.gateway';
import {
  DespachoBloqueadoEvent,
  EVENTO_DESPACHO_BLOQUEADO,
} from './despacho-bloqueado.event';

/** Avisa a los administradores de la distribuidora, por el canal en vivo del panel. */
@Injectable()
export class DespachoBloqueadoListener {
  private readonly logger = new Logger(DespachoBloqueadoListener.name);

  constructor(private readonly admins: AdminGateway) {}

  @OnEvent(EVENTO_DESPACHO_BLOQUEADO)
  handle(evento: DespachoBloqueadoEvent): void {
    // Un aviso que falla nunca tapa el 409 del despacho rechazado.
    try {
      this.admins.notifyAdmins(
        'cylinder:dispatch-blocked',
        {
          orderId: evento.orderId,
          distributorId: evento.distributorId,
          serials: evento.serials,
        },
        evento.distributorId,
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo avisar el despacho bloqueado: ${errorMessage(error)}`,
      );
    }
  }
}
