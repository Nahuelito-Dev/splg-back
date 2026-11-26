import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { errorMessage } from '../common/errors/error-message';
import {
  EVENTO_PEDIDO_ENTREGADO,
  PedidoEntregadoEvent,
} from '../order/domain/events/pedido-entregado.event';
import { RepurchaseOffsetService } from './repurchase-offset.service';

/** Al entregarse un pedido, el ajuste del cliente se recalcula con lo que acaba de pasar. */
@Injectable()
export class RepurchaseOffsetListener {
  private readonly logger = new Logger(RepurchaseOffsetListener.name);

  constructor(private readonly offsets: RepurchaseOffsetService) {}

  @OnEvent(EVENTO_PEDIDO_ENTREGADO)
  async handle(evento: PedidoEntregadoEvent): Promise<void> {
    try {
      await this.offsets.recalcular(
        evento.distributorId,
        evento.customerId,
        new Date(),
      );
    } catch (error) {
      // No bloquea la entrega: el ajuste se recalcula en la próxima.
      this.logger.error(
        `No se pudo recalcular el ajuste de recompra del cliente ${evento.customerId}: ${errorMessage(error)}`,
      );
    }
  }
}
