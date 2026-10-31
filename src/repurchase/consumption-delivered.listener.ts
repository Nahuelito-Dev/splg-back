import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { errorMessage } from '../common/errors/error-message';
import {
  EVENTO_PEDIDO_ENTREGADO,
  PedidoEntregadoEvent,
} from '../order/domain/events/pedido-entregado.event';
import { ConsumptionService } from './consumption.service';

/** Cuando un pedido se entrega, la fecha estimada de recompra del consumo declarado arranca de esa compra. */
@Injectable()
export class ConsumptionDeliveredListener {
  private readonly logger = new Logger(ConsumptionDeliveredListener.name);

  constructor(private readonly consumption: ConsumptionService) {}

  @OnEvent(EVENTO_PEDIDO_ENTREGADO)
  async handle(evento: PedidoEntregadoEvent): Promise<void> {
    try {
      await this.consumption.recalcularTrasEntrega(evento.customerId);
    } catch (error) {
      // No bloquea la entrega: la estimación se recalcula en la próxima edición del consumo.
      this.logger.error(
        `No se pudo recalcular la recompra del cliente ${evento.customerId}: ${errorMessage(error)}`,
      );
    }
  }
}
