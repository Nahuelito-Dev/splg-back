import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { errorMessage } from '../../common/errors/error-message';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash } from 'crypto';
import {
  idCortoDePedido,
  pedirAvisoAlAdmin,
} from '../../common/events/aviso-al-admin';
import { AdminGateway } from '../../gateways/admin.gateway';
import {
  DespachoBloqueadoEvent,
  EVENTO_DESPACHO_BLOQUEADO,
} from '../domain/events/despacho-bloqueado.event';

const CLAVE_MAX = 200;

/**
 * `cylinder-blocked:<pedido o 'suelto'>:<seriales ordenados>`. Con muchos
 * seriales la clave no entra en la columna: se reemplaza la lista por su hash.
 */
function claveDelBloqueo(evento: DespachoBloqueadoEvent): string {
  const base = `cylinder-blocked:${evento.orderId ?? 'suelto'}:`;
  const seriales = [...evento.serials].sort().join(',');
  return base.length + seriales.length <= CLAVE_MAX
    ? base + seriales
    : base + createHash('sha1').update(seriales).digest('hex');
}

/** Avisa a los administradores de la distribuidora, por el canal en vivo del panel. */
@Injectable()
export class DespachoBloqueadoListener {
  private readonly logger = new Logger(DespachoBloqueadoListener.name);

  constructor(
    private readonly admins: AdminGateway,
    private readonly events: EventEmitter2,
  ) {}

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
    const envases = evento.serials.join(', ');
    pedirAvisoAlAdmin(this.events, this.logger, {
      distributorId: evento.distributorId,
      kind: 'cylinder_dispatch_blocked',
      title: 'Despacho bloqueado por envases vencidos',
      body: `${evento.orderId ? `Pedido #${idCortoDePedido(evento.orderId)}: ` : ''}se rechazó asignar envases con la revisión vencida (${envases}).`,
      link: evento.orderId ? { entity: 'order', id: evento.orderId } : null,
      dedupeKey: claveDelBloqueo(evento),
    });
  }
}
