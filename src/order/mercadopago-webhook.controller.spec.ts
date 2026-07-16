import { MercadoPagoWebhookController } from './mercadopago-webhook.controller';

/**
 * Controller receptor del webhook de MercadoPago. Acá vive la validación de
 * FIRMA (el use-case asume que ya está validada): con firma inválida NUNCA se
 * llama a ConfirmPaymentUseCase, aunque siempre se responda 200 (no revelar
 * nada al llamante).
 */
describe('MercadoPagoWebhookController', () => {
  let controller: MercadoPagoWebhookController;
  let paymentsService: { verifyWebhookSignature: jest.Mock };
  let confirmPayment: { execute: jest.Mock };

  beforeEach(() => {
    paymentsService = { verifyWebhookSignature: jest.fn() };
    confirmPayment = { execute: jest.fn().mockResolvedValue(undefined) };
    controller = new MercadoPagoWebhookController(
      paymentsService as any,
      confirmPayment as any,
    );
  });

  it('firma inválida: NO procesa la notificación pero responde 200', async () => {
    paymentsService.verifyWebhookSignature.mockReturnValue(false);

    const result = await controller.handle(
      { type: 'payment', 'data.id': 'pay-1' } as any,
      'firma-trucha',
      'req-1',
    );

    expect(confirmPayment.execute).not.toHaveBeenCalled();
    expect(result).toEqual({ received: true });
  });

  it('firma válida: delega en ConfirmPaymentUseCase con type/dataId', async () => {
    paymentsService.verifyWebhookSignature.mockReturnValue(true);

    await controller.handle(
      { type: 'payment', 'data.id': 'pay-1' } as any,
      'firma-ok',
      'req-1',
    );

    expect(confirmPayment.execute).toHaveBeenCalledWith({
      type: 'payment',
      dataId: 'pay-1',
      xSignature: 'firma-ok',
      xRequestId: 'req-1',
    });
  });

  it('un error interno del use-case no rompe la respuesta (siempre 200)', async () => {
    paymentsService.verifyWebhookSignature.mockReturnValue(true);
    confirmPayment.execute.mockRejectedValue(new Error('boom'));

    const result = await controller.handle(
      { type: 'payment', 'data.id': 'pay-1' } as any,
      'firma-ok',
      'req-1',
    );

    expect(result).toEqual({ received: true });
  });
});
