import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FcmPort } from '../firebase/ports/fcm.port';
import { DriversGateway } from '../gateways/drivers.gateway';
import { pedirAvisoAlAdmin } from '../common/events/aviso-al-admin';
import { errorMessage } from '../common/errors/error-message';
import { Delivery } from '../delivery/entities/delivery.entity';

/** Lo que el chofer necesita para decidir sin abrir el lote. */
export interface OfertaDeLote {
  batchId: string;
  offerId: string;
  expiresAt: Date;
  totalWeightKg: number;
  stopCount: number;
}

export type MotivoDeCierre = 'expired' | 'dissolved' | 'withdrawn';

/**
 * Los avisos de la agrupación por recorrido (CU-107): al chofer por socket y
 * push, y al administrador por la bandeja. Todo es best-effort: el hecho que
 * se avisa ya ocurrió, así que una entrega que falla se registra y no lo deshace.
 */
@Injectable()
export class RouteBatchNotifier {
  private readonly logger = new Logger(RouteBatchNotifier.name);

  constructor(
    private readonly drivers: DriversGateway,
    private readonly fcm: FcmPort,
    private readonly events: EventEmitter2,
  ) {}

  /** Lote ofrecido: socket y push al chofer. */
  async ofertaAlChofer(
    delivery: Delivery,
    oferta: OfertaDeLote,
  ): Promise<void> {
    this.seguro('socket', () =>
      this.drivers.notifyRouteBatch(delivery.userId, 'route-batch:offer', {
        batchId: oferta.batchId,
        offerId: oferta.offerId,
        expiresAt: oferta.expiresAt.toISOString(),
        totalWeightKg: oferta.totalWeightKg,
        stopCount: oferta.stopCount,
      }),
    );
    if (!delivery.notificationToken) return;
    const token = delivery.notificationToken;
    try {
      await this.fcm.sendToToken(
        token,
        {
          notification: {
            title: 'Recorrido para vos',
            body: `${oferta.stopCount} entregas agrupadas (${oferta.totalWeightKg} kg). Abrí la app para aceptarlo.`,
          },
          data: { type: 'ROUTE_BATCH_OFFER', batchId: oferta.batchId },
          android: { priority: 'high' },
          apns: { headers: { 'apns-priority': '10' } },
        },
        {
          type: 'ROUTE_BATCH_OFFER',
          distributorId: delivery.distributorId,
          recipientUserId: delivery.userId,
        },
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo enviar el push del lote ${oferta.batchId}: ${errorMessage(error)}`,
      );
    }
  }

  /** La oferta ya no corre (venció, el lote se deshizo o se retiró): la app la saca de la lista. */
  ofertaCerrada(userId: string, batchId: string, motivo: MotivoDeCierre): void {
    this.seguro('socket', () =>
      this.drivers.notifyRouteBatch(userId, 'route-batch:offer-closed', {
        batchId,
        reason: motivo,
      }),
    );
  }

  /** El chofer aceptó: los pedidos del lote quedaron asignados, en orden. */
  loteAsignado(userId: string, batchId: string, orderIds: string[]): void {
    this.seguro('socket', () =>
      this.drivers.notifyRouteBatch(userId, 'route-batch:assigned', {
        batchId,
        orderIds,
      }),
    );
  }

  /** Ningún chofer tomó el lote: los pedidos volvieron al despacho individual. */
  loteSinChofer(distributorId: string, batchId: string, pedidos: number): void {
    pedirAvisoAlAdmin(this.events, this.logger, {
      distributorId,
      kind: 'route_batch_exhausted',
      title: 'Recorrido sin chofer',
      body: `Ningún chofer tomó un lote de ${pedidos} pedidos agrupados: volvieron al despacho individual.`,
      link: null,
      dedupeKey: `route-batch-exhausted:${batchId}`,
    });
  }

  private seguro(canal: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.logger.warn(`Aviso por ${canal} falló: ${errorMessage(error)}`);
    }
  }
}
