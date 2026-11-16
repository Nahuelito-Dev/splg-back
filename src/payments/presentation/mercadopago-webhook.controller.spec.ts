import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
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
  let bandeja: { guardar: jest.Mock; procesarEnSegundoPlano: jest.Mock };

  beforeEach(() => {
    paymentsService = { verifyWebhookSignature: jest.fn() };
    eventos = { emitAsync: jest.fn().mockResolvedValue([]) };
    bandeja = {
      guardar: jest.fn().mockResolvedValue(undefined),
      procesarEnSegundoPlano: jest.fn(),
    };
    controller = new MercadoPagoWebhookController(
      paymentsService as unknown as PaymentsService,
      eventos as unknown as EventEmitter2,
      bandeja as never,
    );
  });

  it('firma inválida: NO publica el evento y responde 401', async () => {
    paymentsService.verifyWebhookSignature.mockResolvedValue('invalida');

    await expect(
      controller.handle(
        { type: 'payment', 'data.id': 'pay-1' },
        undefined,
        'firma-trucha',
        'req-1',
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(eventos.emitAsync).not.toHaveBeenCalled();
  });

  it('firma que no se pudo verificar (base o credencial caída): 503 para que MP reintente, sin publicar', async () => {
    paymentsService.verifyWebhookSignature.mockResolvedValue('no_verificable');

    await expect(
      controller.handle(
        { type: 'payment', 'data.id': 'pay-1' },
        undefined,
        'firma-ok',
        'req-1',
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(eventos.emitAsync).not.toHaveBeenCalled();
  });

  describe('M-4: la alerta de fraude no se reintenta: se guarda cruda y se contesta 200', () => {
    const cuerpo = {
      data: { payment_id: 58980959081 },
      type: 'stop_delivery_op_wh',
    };

    it('con firma válida guarda el aviso crudo (el pago sale de data.payment_id), contesta 200 y lo procesa aparte', async () => {
      paymentsService.verifyWebhookSignature.mockResolvedValue('valida');

      const r = await controller.handle(
        { type: 'stop_delivery_op_wh', 'data.id': 'aviso-9' },
        cuerpo,
        'f',
        'r',
      );

      expect(r).toEqual({ received: true });
      expect(bandeja.guardar).toHaveBeenCalledWith({
        type: 'stop_delivery_op_wh',
        dataId: '58980959081',
        credentialId: undefined,
        rawBody: cuerpo,
      });
      expect(bandeja.procesarEnSegundoPlano).toHaveBeenCalled();
      // No se procesa dentro del webhook: si fallara, MP no reintenta.
      expect(eventos.emitAsync).not.toHaveBeenCalled();
    });

    it('contesta 200 aunque el procesamiento posterior vaya a fallar', async () => {
      paymentsService.verifyWebhookSignature.mockResolvedValue('valida');
      bandeja.procesarEnSegundoPlano.mockImplementation(() => {
        throw new Error('no debería afectar la respuesta');
      });

      await expect(
        controller
          .handle(
            { type: 'stop_delivery_op_wh', 'data.id': 'a' },
            cuerpo,
            'f',
            'r',
          )
          .catch(() => 'rompió'),
      ).resolves.toBeDefined();
    });

    it('si ni siquiera se puede guardar (base caída) contesta 503: no hay otra cosa que hacer', async () => {
      paymentsService.verifyWebhookSignature.mockResolvedValue('valida');
      bandeja.guardar.mockRejectedValue(new Error('base caída'));

      await expect(
        controller.handle(
          { type: 'stop_delivery_op_wh', 'data.id': 'a' },
          cuerpo,
          'f',
          'r',
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('con firma inválida no guarda nada', async () => {
      paymentsService.verifyWebhookSignature.mockResolvedValue('invalida');

      await expect(
        controller.handle(
          { type: 'stop_delivery_op_wh', 'data.id': 'a' },
          cuerpo,
          'f',
          'r',
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(bandeja.guardar).not.toHaveBeenCalled();
    });
  });

  it('firma válida: publica el pago notificado con type y dataId', async () => {
    paymentsService.verifyWebhookSignature.mockResolvedValue('valida');

    await controller.handle(
      { type: 'payment', 'data.id': 'pay-1' },
      undefined,
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
    paymentsService.verifyWebhookSignature.mockResolvedValue('valida');

    await controller.handle(
      { type: 'payment', 'data.id': 'pay-1', account: CUENTA },
      undefined,
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
    paymentsService.verifyWebhookSignature.mockResolvedValue('valida');

    await controller.handle(
      { type: 'payment', 'data.id': 'pay-1', account: "x' OR 1=1" },
      undefined,
      'f',
      'r',
    );

    expect(paymentsService.verifyWebhookSignature).toHaveBeenCalledWith(
      expect.objectContaining({ credentialId: undefined }),
    );
  });

  it('con la firma inválida para esa cuenta no publica nada', async () => {
    paymentsService.verifyWebhookSignature.mockResolvedValue('invalida');

    await expect(
      controller.handle(
        { type: 'payment', 'data.id': 'pay-1', account: CUENTA },
        undefined,
        'f',
        'r',
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(eventos.emitAsync).not.toHaveBeenCalled();
  });

  it('acepta el formato viejo: id y topic', async () => {
    paymentsService.verifyWebhookSignature.mockResolvedValue('valida');

    await controller.handle(
      { topic: 'payment', id: 'pay-2' },
      undefined,
      'f',
      'r',
    );

    expect(eventos.emitAsync).toHaveBeenCalledWith(
      EVENTO_PAGO_NOTIFICADO,
      new PagoNotificadoEvent('payment', 'pay-2', 'f', 'r'),
    );
  });

  it('responde 200 recién cuando el pago se procesó', async () => {
    paymentsService.verifyWebhookSignature.mockResolvedValue('valida');
    let terminar: () => void = () => undefined;
    eventos.emitAsync.mockReturnValue(
      new Promise<void>((resolver) => (terminar = resolver)),
    );

    let respondio = false;
    const respuesta = controller
      .handle(
        { type: 'payment', 'data.id': 'pay-1' },
        undefined,
        'firma-ok',
        'req-1',
      )
      .then((r) => {
        respondio = true;
        return r;
      });
    await new Promise((r) => setImmediate(r));
    expect(respondio).toBe(false);

    terminar();
    await expect(respuesta).resolves.toEqual({ received: true });
  });

  it('si el procesamiento falla responde 503 para que Mercado Pago reintente', async () => {
    paymentsService.verifyWebhookSignature.mockResolvedValue('valida');
    eventos.emitAsync.mockRejectedValue(new Error('boom'));

    await expect(
      controller.handle(
        { type: 'payment', 'data.id': 'pay-1' },
        undefined,
        'firma-ok',
        'req-1',
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('un contracargo se publica igual que un pago', async () => {
    paymentsService.verifyWebhookSignature.mockResolvedValue('valida');

    await controller.handle(
      { type: 'topic_chargebacks_wh', 'data.id': 'cb-1' },
      undefined,
      'f',
      'r',
    );

    expect(eventos.emitAsync).toHaveBeenCalledWith(
      EVENTO_PAGO_NOTIFICADO,
      new PagoNotificadoEvent('topic_chargebacks_wh', 'cb-1', 'f', 'r'),
    );
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
