import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { errorMessage } from '../../common/errors/error-message';
import {
  EVENTO_PEDIDO_ENTREGADO,
  PedidoEntregadoEvent,
} from '../../order/domain/events/pedido-entregado.event';
import { PaymentMethod } from '../../order/entities/order.entity';
import { CustomerLedgerService } from './customer-ledger.service';

/** Cuando se entrega un pedido a cuenta corriente, asienta su cargo (CU-332). */
@Injectable()
export class CustomerChargeListener {
  private readonly logger = new Logger(CustomerChargeListener.name);

  constructor(private readonly ledger: CustomerLedgerService) {}

  @OnEvent(EVENTO_PEDIDO_ENTREGADO)
  async handle(evento: PedidoEntregadoEvent): Promise<void> {
    if (evento.paymentMethod !== PaymentMethod.ACCOUNT) return;
    try {
      await this.ledger.asentarCargo(evento.orderId);
    } catch (error) {
      // No bloquea la entrega: el barrido nocturno lo recupera.
      this.logger.error(
        `No se pudo asentar el cargo del pedido ${evento.orderId}: ${errorMessage(error)}`,
      );
    }
  }
}
