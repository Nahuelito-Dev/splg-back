import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  EVENTO_PAGO_REINTEGRADO,
  EVENTO_REINTEGRO_FALLIDO,
  PagoReintegradoEvent,
  ReintegroFallidoEvent,
} from '../../payments/domain/events/reintegro.events';
import { OrderLookupService } from '../lookup/order-lookup.service';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import { NotificationPort } from '../domain/ports/notification.port';
import { errorMessage } from '../../common/errors/error-message';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  idCortoDePedido,
  pedirAvisoAlAdmin,
} from '../../common/events/aviso-al-admin';

/**
 * CU-168 pasos 6 y excepción del 4: cuando `payments` resuelve una devolución,
 * el pedido avisa al panel y al cliente, en tiempo real. `payments` no sabe de
 * clientes ni de salas: publica el evento y acá se traduce a avisos. Un fallo al
 * avisar no afecta a la devolución (ya está registrada).
 */
@Injectable()
export class ReintegroListener {
  private readonly logger = new Logger(ReintegroListener.name);

  constructor(
    private readonly orders: OrderLookupService,
    private readonly realtime: RealtimeDispatchPort,
    private readonly notifications: NotificationPort,
    private readonly events: EventEmitter2,
  ) {}

  @OnEvent(EVENTO_PAGO_REINTEGRADO)
  async onReintegrado(evento: PagoReintegradoEvent): Promise<void> {
    const r = evento.reintegro;
    try {
      const pedido = await this.orders.findForRefund(r.orderId);
      if (!pedido) return;
      const payload = {
        orderId: r.orderId,
        refundId: r.refundId,
        kind: r.kind,
        amount: r.amount,
        at: new Date().toISOString(),
      };
      this.realtime.notifyCustomer(
        pedido.customerId,
        'order:payment-refunded',
        payload,
      );
      this.realtime.notifyAdmins(
        'order:payment-refunded',
        { ...payload, distributorId: r.distributorId },
        r.distributorId,
      );
      void this.notifications
        .sendOrderNoticePush(pedido.customerId, r.orderId, {
          title: 'Te devolvimos el pago',
          body: `Te devolvimos $${r.amount} por tu pedido #${r.orderId.substring(0, 8)}.`,
          event: 'PAYMENT_REFUNDED',
        })
        .catch(() => undefined);
    } catch (error) {
      this.logger.warn(
        `No se pudo avisar la devolución ${r.refundId}: ${errorMessage(error)}`,
      );
    }
  }

  @OnEvent(EVENTO_REINTEGRO_FALLIDO)
  onFallido(evento: ReintegroFallidoEvent): void {
    const r = evento.reintegro;
    try {
      this.realtime.notifyAdmins(
        'order:refund-failed',
        {
          orderId: r.orderId,
          refundId: r.refundId,
          kind: r.kind,
          amount: r.amount,
          reason: evento.motivo,
          distributorId: r.distributorId,
          at: new Date().toISOString(),
        },
        r.distributorId,
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo avisar la devolución fallida ${r.refundId}: ${errorMessage(error)}`,
      );
    }
    if (r.distributorId) {
      pedirAvisoAlAdmin(this.events, this.logger, {
        distributorId: r.distributorId,
        kind: 'refund_failed',
        title: 'Devolución fallida',
        body: `Pedido #${idCortoDePedido(r.orderId)}: no se pudo devolver $${r.amount}. ${evento.motivo}`,
        link: { entity: 'order', id: r.orderId },
        // Con el intento: si el reintento vuelve a fallar, es un aviso nuevo.
        dedupeKey: `refund-failed:${r.refundId}:${r.attempts}`,
      });
    }
  }
}
