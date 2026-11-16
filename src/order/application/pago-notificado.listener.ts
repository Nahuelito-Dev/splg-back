import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  EVENTO_PAGO_NOTIFICADO,
  PagoNotificadoEvent,
} from '../../payments/domain/events/pago-notificado.event';
import { ConfirmPaymentUseCase } from './confirm-payment.use-case';

/**
 * Cuando `payments` recibe un webhook válido, el pedido de ese pago se
 * confirma. `suppressErrors: false` para que un fallo llegue al webhook, que lo
 * registra y responde 200 igual.
 */
@Injectable()
export class PagoNotificadoListener {
  constructor(private readonly confirmPayment: ConfirmPaymentUseCase) {}

  @OnEvent(EVENTO_PAGO_NOTIFICADO, { suppressErrors: false })
  handle(evento: PagoNotificadoEvent): Promise<void> {
    return this.confirmPayment.execute({
      type: evento.type,
      dataId: evento.dataId,
      xSignature: evento.xSignature,
      xRequestId: evento.xRequestId,
      credentialId: evento.credentialId,
    });
  }
}
