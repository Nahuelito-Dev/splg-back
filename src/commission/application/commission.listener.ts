import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { errorMessage } from '../../common/errors/error-message';
import {
  EVENTO_PEDIDO_ENTREGADO,
  PedidoEntregadoEvent,
} from '../../order/domain/events/pedido-entregado.event';
import { CommissionLedgerService } from './commission-ledger.service';

/** Cuando un pedido se entrega, devenga la comisión del chofer (CU-241). */
@Injectable()
export class CommissionListener {
  private readonly logger = new Logger(CommissionListener.name);

  constructor(private readonly ledger: CommissionLedgerService) {}

  @OnEvent(EVENTO_PEDIDO_ENTREGADO)
  async handle(evento: PedidoEntregadoEvent): Promise<void> {
    try {
      await this.ledger.devengarPorPedido(evento.orderId);
    } catch (error) {
      // No bloquea la entrega: el barrido nocturno lo recupera.
      this.logger.error(
        `No se pudo devengar la comisión del pedido ${evento.orderId}: ${errorMessage(error)}`,
      );
    }
  }
}
