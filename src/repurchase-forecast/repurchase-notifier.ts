import { Injectable, Logger } from '@nestjs/common';
import { CustomersService } from '../customer/customer.service';
import { FcmPort } from '../firebase/ports/fcm.port';
import { CustomersGateway } from '../gateways/customers.gateway';
import { errorMessage } from '../common/errors/error-message';
import { ZONA_ARGENTINA } from '../common/utils/dias-argentina';
import { RepurchaseInvitation } from './entities/repurchase-invitation.entity';

/** Eventos de socket de la app del cliente. */
export const EVENTO_INVITACION = 'repurchase:invitation';
export const EVENTO_INVITACION_CERRADA = 'repurchase:invitation-closed';

function fechaCorta(fecha: Date): string {
  return fecha.toLocaleDateString('es-AR', {
    timeZone: ZONA_ARGENTINA,
    day: 'numeric',
    month: 'long',
  });
}

/**
 * Los avisos de la recompra anticipada (CU-106) al cliente: por socket, para la
 * app abierta, y por push, para la cerrada. Es best-effort: la invitación ya
 * existe y se ve en la app, así que un aviso que falla se registra y nada más.
 */
@Injectable()
export class RepurchaseNotifier {
  private readonly logger = new Logger(RepurchaseNotifier.name);

  constructor(
    private readonly clientes: CustomersGateway,
    private readonly customers: CustomersService,
    private readonly fcm: FcmPort,
  ) {}

  /** Invitación nueva: socket y push. */
  async invitar(invitacion: RepurchaseInvitation): Promise<void> {
    const unidades = invitacion.suggestedItems.reduce(
      (n, i) => n + i.quantity,
      0,
    );
    const pedido = `Tu pedido de ${unidades} ${unidades === 1 ? 'garrafa' : 'garrafas'} está listo para confirmar.`;
    // Un cliente atrasado no recibe una fecha que ya pasó.
    const detalle =
      invitacion.projectedDepletionAt.getTime() <= Date.now()
        ? `Ya te tocaría reponer. ${pedido}`
        : `Tu gas se acaba cerca del ${fechaCorta(invitacion.projectedDepletionAt)}. ${pedido}`;
    await this.seguro('socket', () =>
      this.clientes.notifyCustomer(invitacion.userId, EVENTO_INVITACION, {
        invitationId: invitacion.invitationId,
        distributorId: invitacion.distributorId,
        projectedDepletionAt: invitacion.projectedDepletionAt.toISOString(),
        expiresAt: invitacion.expiresAt.toISOString(),
      }),
    );
    await this.seguro('push', async () => {
      const { token } = await this.customers.findNotificationToken(
        invitacion.userId,
      );
      if (!token) return;
      await this.fcm.sendToToken(token, {
        notification: { title: '¿Reponés tu garrafa?', body: detalle },
        data: {
          event: 'REPURCHASE_INVITATION',
          invitationId: invitacion.invitationId,
          distributorId: invitacion.distributorId,
        },
      });
    });
  }

  /** La invitación ya no corre (venció o se cerró): la app la saca de la lista. */
  async cerrada(
    invitacion: RepurchaseInvitation,
    motivo: 'expired' | 'cancelled',
  ): Promise<void> {
    await this.seguro('socket', () =>
      this.clientes.notifyCustomer(
        invitacion.userId,
        EVENTO_INVITACION_CERRADA,
        { invitationId: invitacion.invitationId, reason: motivo },
      ),
    );
  }

  private async seguro(
    canal: string,
    envio: () => void | Promise<void>,
  ): Promise<void> {
    try {
      await envio();
    } catch (error) {
      this.logger.warn(
        `No se pudo avisar por ${canal} de la recompra: ${errorMessage(error)}`,
      );
    }
  }
}
