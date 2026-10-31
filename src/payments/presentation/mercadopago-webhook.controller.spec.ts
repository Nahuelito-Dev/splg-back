import { EventEmitter2 } from '@nestjs/event-emitter';
import { MercadoPagoWebhookController } from './mercadopago-webhook.controller';
import { PaymentsService } from '../application/payments.service';
import {
  EVENTO_PAGO_NOTIFICADO,
  PagoNotificadoEvent,
} from '../domain/events/pago-notificado.event';
import { PagoNotificadoListener } from '../../order/application/pago-notificado.listener';
import { ConfirmPaymentUseCase } from '../../order/application/confirm-payment.use-case';

/**
 * Receptor del webhook de MercadoPago. Acá vive la validación de FIRMA: con
 * firma inválida NUNCA se publica el evento, aunque siempre se responda 200
 * (no revelar nada al llamante). Con firma válida se publica y order confirma
 * el pedido.
 */
describe('MercadoPagoWebhookController', () => {
  let controller: MercadoPagoWebhookController;
  let paymentsService: { verifyWebhookSignature: jest.Mock };
  let eventos: { emitAsync: jest.Mock };

  beforeEach(() => {
    paymentsService = { verifyWebhookSignature: jest.fn() };
    eventos = { emitAsync: jest.fn().mockResolvedValue([]) };
    controller = new MercadoPagoWebhookController(
      paymentsService as unknown as PaymentsService,
      eventos as unknown as EventEmitter2,
    );
  });

  it('firma inválida: NO publica el evento pero responde 200', async () => {
    paymentsService.verifyWebhookSignature.mockReturnValue(false);

    const result = await controller.handle(
      { type: 'payment', 'data.id': 'pay-1' },
      'firma-trucha',
      'req-1',
    );

    expect(eventos.emitAsync).not.toHaveBeenCalled();
    expect(result).toEqual({ received: true });
  });

  it('firma válida: publica el pago notificado con type y dataId', async () => {
    paymentsService.verifyWebhookSignature.mockReturnValue(true);

    await controller.handle(
      { type: 'payment', 'data.id': 'pay-1' },
      'firma-ok',
      'req-1',
    );

    expect(eventos.emitAsync).toHaveBeenCalledWith(
      EVENTO_PAGO_NOTIFICADO,
      new PagoNotificadoEvent('payment', 'pay-1', 'firma-ok', 'req-1'),
    );
  });

  const CUENTA = '0b6c1c0e-6d0c-4a43-9d4e-5b1f2a7a1c11';

  it('con ?account= valida la firma con esa cuenta y la pasa en el evento', async () => {
    paymentsService.verifyWebhookSignature.mockResolvedValue(true);

    await controller.handle(
      { type: 'payment', 'data.id': 'pay-1', account: CUENTA },
      'f',
      'r',
    );

    expect(paymentsService.verifyWebhookSignature).toHaveBeenCalledWith({
      xSignature: 'f',
      xRequestId: 'r',
      dataId: 'pay-1',
      credentialId: CUENTA,
    });
    expect(eventos.emitAsync).toHaveBeenCalledWith(
      EVENTO_PAGO_NOTIFICADO,
      new PagoNotificadoEvent('payment', 'pay-1', 'f', 'r', CUENTA),
    );
  });

  it('un account que no es un id se ignora: valida con la cuenta del entorno', async () => {
    paymentsService.verifyWebhookSignature.mockResolvedValue(true);

    await controller.handle(
      { type: 'payment', 'data.id': 'pay-1', account: "x' OR 1=1" },
      'f',
      'r',
    );

    expect(paymentsService.verifyWebhookSignature).toHaveBeenCalledWith(
      expect.objectContaining({ credentialId: undefined }),
    );
  });

  it('con la firma inválida para esa cuenta no publica nada', async () => {
    paymentsService.verifyWebhookSignature.mockResolvedValue(false);

    await controller.handle(
      { type: 'payment', 'data.id': 'pay-1', account: CUENTA },
      'f',
      'r',
    );

    expect(eventos.emitAsync).not.toHaveBeenCalled();
  });

  it('acepta el formato viejo: id y topic', async () => {
    paymentsService.verifyWebhookSignature.mockReturnValue(true);

    await controller.handle({ topic: 'payment', id: 'pay-2' }, 'f', 'r');

    expect(eventos.emitAsync).toHaveBeenCalledWith(
      EVENTO_PAGO_NOTIFICADO,
      new PagoNotificadoEvent('payment', 'pay-2', 'f', 'r'),
    );
  });

  it('un error de quien escucha no rompe la respuesta (siempre 200)', async () => {
    paymentsService.verifyWebhookSignature.mockReturnValue(true);
    eventos.emitAsync.mockRejectedValue(new Error('boom'));

    const result = await controller.handle(
      { type: 'payment', 'data.id': 'pay-1' },
      'firma-ok',
      'req-1',
    );

    expect(result).toEqual({ received: true });
  });
});

describe('PagoNotificadoListener', () => {
  it('confirma el pedido con los datos del evento', async () => {
    const confirmPayment = { execute: jest.fn().mockResolvedValue(undefined) };
    const listener = new PagoNotificadoListener(
      confirmPayment as unknown as ConfirmPaymentUseCase,
    );

    await listener.handle(
      new PagoNotificadoEvent('payment', 'pay-1', 'firma', 'req'),
    );

    expect(confirmPayment.execute).toHaveBeenCalledWith({
      type: 'payment',
      dataId: 'pay-1',
      xSignature: 'firma',
      xRequestId: 'req',
    });
  });
});
