import { NotFoundException } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { FcmPort } from '../firebase/ports/fcm.port';
import { CustomersService } from '../customer/customer.service';
import { DeliveryService } from '../delivery/delivery.service';
import { OrderLookupService } from '../order/lookup/order-lookup.service';
import { RedisService } from '../redis/redis.service';

/**
 * El servicio de notificaciones arma los mensajes y los manda por FcmPort. Los
 * tokens de los dispositivos son de clientes y choferes: los pide a sus
 * servicios. Los push son complementarios al tiempo real y nunca rompen el
 * flujo que los dispara.
 */
describe('NotificationsService', () => {
  let service: NotificationsService;
  let customers: {
    findNotificationToken: jest.Mock;
    saveNotificationToken: jest.Mock;
    assertDeLaDistribuidora: jest.Mock;
  };
  let deliveries: {
    findNotificationToken: jest.Mock;
    saveNotificationToken: jest.Mock;
  };
  let sendToToken: jest.Mock;
  const mensajeEnviado = () =>
    (
      sendToToken.mock.calls[0] as [string, { notification: { body: string } }]
    )[1];
  let orders: { findRef: jest.Mock };
  let redis: { setIfAbsent: jest.Mock; del: jest.Mock };

  beforeEach(() => {
    customers = {
      findNotificationToken: jest.fn(),
      saveNotificationToken: jest.fn(),
      assertDeLaDistribuidora: jest.fn().mockResolvedValue(undefined),
    };
    deliveries = {
      findNotificationToken: jest.fn(),
      saveNotificationToken: jest.fn(),
    };
    sendToToken = jest.fn().mockResolvedValue('msg-1');
    orders = { findRef: jest.fn().mockResolvedValue({ customerId: 'c1' }) };

    redis = {
      setIfAbsent: jest.fn().mockResolvedValue(true),
      del: jest.fn().mockResolvedValue(undefined),
    };

    service = new NotificationsService(
      customers as unknown as CustomersService,
      deliveries as unknown as DeliveryService,
      { sendToToken } as unknown as FcmPort,
      orders as unknown as OrderLookupService,
      redis as unknown as RedisService,
    );
  });

  const salida = (monto: number, salidaId = 'd1:0') => ({
    monto,
    salida: salidaId,
  });

  describe('avisos del efectivo (C4)', () => {
    it('la confirmación del pedido en efectivo dice cuánto se paga al recibirlo', async () => {
      customers.findNotificationToken.mockResolvedValue({
        esCliente: true,
        token: 'tok',
      });

      await service.sendOrderConfirmation('c1', 'order-12345678', undefined, {
        monto: 12500,
        senaDescontada: 0,
      });

      const mensaje = mensajeEnviado();
      expect(mensaje.notification.body).toContain(
        'Pagás $12.500 en efectivo cuando te lo entreguen.',
      );
    });

    it('la confirmación de una reserva con seña dice que ya está descontada', async () => {
      customers.findNotificationToken.mockResolvedValue({
        esCliente: true,
        token: 'tok',
      });

      await service.sendOrderConfirmation('c1', 'order-12345678', undefined, {
        monto: 17600,
        senaDescontada: 5000,
      });

      expect(mensajeEnviado().notification.body).toContain(
        'Pagás $17.600 en efectivo cuando te lo entreguen (ya descontada la seña de $5.000).',
      );
    });

    it('la confirmación de un pedido que no es en efectivo no menciona efectivo', async () => {
      customers.findNotificationToken.mockResolvedValue({
        esCliente: true,
        token: 'tok',
      });

      await service.sendOrderConfirmation(
        'c1',
        'order-12345678',
        undefined,
        null,
      );

      const mensaje = mensajeEnviado();
      expect(mensaje.notification.body).not.toContain('efectivo');
    });

    it('al salir el chofer avisa «Tené listos $X» con el evento CASH_READY', async () => {
      customers.findNotificationToken.mockResolvedValue({ token: 'tok' });

      const r = await service.sendCashReadyPush('c1', 'order-1', salida(12000));

      expect(r).toBe('sent');
      expect(mensajeEnviado().notification.body).toBe(
        'Tené listos $12.000 en efectivo.',
      );
      expect(sendToToken).toHaveBeenCalledWith(
        'tok',
        expect.objectContaining({
          data: { event: 'CASH_READY', orderId: 'order-1' },
        }),
      );
    });

    it('con un monto no redondo sugiere juntar el monto exacto', async () => {
      customers.findNotificationToken.mockResolvedValue({ token: 'tok' });

      await service.sendCashReadyPush('c1', 'order-1', salida(12345.5));

      const mensaje = mensajeEnviado();
      expect(mensaje.notification.body).toContain('$12.345,50');
      expect(mensaje.notification.body).toContain('monto exacto');
    });

    it('no repite el aviso del mismo pedido', async () => {
      redis.setIfAbsent.mockResolvedValue(false);

      const r = await service.sendCashReadyPush('c1', 'order-1', salida(12000));

      expect(r).toBe('duplicate');
      expect(sendToToken).not.toHaveBeenCalled();
    });

    it('la clave de dedupe lleva pedido, monto y salida: otro monto u otra salida avisa de nuevo', async () => {
      customers.findNotificationToken.mockResolvedValue({ token: 'tok' });

      await service.sendCashReadyPush('c1', 'order-1', salida(12000));
      await service.sendCashReadyPush('c1', 'order-1', salida(13000));
      await service.sendCashReadyPush('c1', 'order-1', salida(12000, 'd1:1'));

      expect(redis.setIfAbsent.mock.calls.map((c: unknown[]) => c[0])).toEqual([
        'aviso:efectivo-listo:order-1:12000:d1:0',
        'aviso:efectivo-listo:order-1:13000:d1:0',
        'aviso:efectivo-listo:order-1:12000:d1:1',
      ]);
      expect(sendToToken).toHaveBeenCalledTimes(3);
    });

    it('si Redis no responde avisa igual y lo deja en el log', async () => {
      customers.findNotificationToken.mockResolvedValue({ token: 'tok' });
      redis.setIfAbsent.mockRejectedValue(new Error('Redis caído'));

      const r = await service.sendCashReadyPush('c1', 'order-1', salida(12000));

      expect(r).toBe('sent');
      expect(sendToToken).toHaveBeenCalledTimes(1);
      expect(redis.del).not.toHaveBeenCalled();
    });

    it('el push de «en camino» de un pedido en efectivo suma el efectivo en un solo aviso', async () => {
      customers.findNotificationToken.mockResolvedValue({ token: 'tok' });

      await service.sendOrderNoticePush(
        'c1',
        'order-1',
        {
          title: 'Tu pedido está en camino',
          body: 'El chofer salió con tu pedido.',
          event: 'ORDER_TRIP_STARTED',
        },
        salida(12000),
      );

      expect(sendToToken).toHaveBeenCalledTimes(1);
      expect(mensajeEnviado().notification.body).toBe(
        'El chofer salió con tu pedido. Tené listos $12.000 en efectivo.',
      );
    });

    it('si el aviso del efectivo ya salió, «en camino» sale sin repetirlo', async () => {
      customers.findNotificationToken.mockResolvedValue({ token: 'tok' });
      redis.setIfAbsent.mockResolvedValue(false);

      await service.sendOrderNoticePush(
        'c1',
        'order-1',
        { title: 'Tu pedido está en camino', body: 'Salió.', event: 'X' },
        salida(12000),
      );

      expect(mensajeEnviado().notification.body).toBe('Salió.');
    });

    it('si el push combinado no sale libera la marca del efectivo', async () => {
      customers.findNotificationToken.mockResolvedValue({ token: 'tok' });
      sendToToken.mockRejectedValue(new Error('FCM caído'));

      await service.sendOrderNoticePush(
        'c1',
        'order-1',
        { title: 't', body: 'b', event: 'X' },
        salida(12000),
      );

      expect(redis.del).toHaveBeenCalledWith(
        'aviso:efectivo-listo:order-1:12000:d1:0',
      );
    });

    it('si no salió (sin token) libera la marca para poder reintentar', async () => {
      customers.findNotificationToken.mockResolvedValue({ token: null });

      const r = await service.sendCashReadyPush('c1', 'order-1', salida(12000));

      expect(r).toBe('no_token');
      expect(redis.del).toHaveBeenCalledWith(
        'aviso:efectivo-listo:order-1:12000:d1:0',
      );
    });

    it('si FCM falla no lanza y libera la marca', async () => {
      customers.findNotificationToken.mockResolvedValue({ token: 'tok' });
      sendToToken.mockRejectedValue(new Error('FCM caído'));

      await expect(
        service.sendCashReadyPush('c1', 'order-1', salida(12000)),
      ).resolves.toBe('failed');
      expect(redis.del).toHaveBeenCalled();
    });
  });

  describe('sendOfferPushToDriver', () => {
    it('manda el push al token FCM del chofer con el evento NEW_ORDER', async () => {
      deliveries.findNotificationToken.mockResolvedValue('fcm-token-driver');

      await service.sendOfferPushToDriver('driver-1', 'order-99');

      expect(sendToToken).toHaveBeenCalledWith(
        'fcm-token-driver',
        expect.objectContaining({
          data: { event: 'NEW_ORDER', orderId: 'order-99' },
        }),
      );
    });

    it('la oferta de un pedido en efectivo trae el monto a cobrar en el push', async () => {
      deliveries.findNotificationToken.mockResolvedValue('fcm-token-driver');

      await service.sendOfferPushToDriver('driver-1', 'order-99', 22600);

      expect(sendToToken).toHaveBeenCalledWith(
        'fcm-token-driver',
        expect.objectContaining({
          data: {
            event: 'NEW_ORDER',
            orderId: 'order-99',
            cashToCollect: '22600',
          },
          notification: expect.objectContaining({
            body: expect.stringContaining(
              'Se cobra en efectivo: $22.600',
            ) as string,
          }) as unknown,
        }),
      );
    });

    it('no manda nada si el chofer no tiene token FCM registrado', async () => {
      deliveries.findNotificationToken.mockResolvedValue(null);

      await service.sendOfferPushToDriver('driver-2', 'order-1');

      expect(sendToToken).not.toHaveBeenCalled();
    });

    it('nunca lanza: si FCM falla, el despacho no se rompe', async () => {
      deliveries.findNotificationToken.mockResolvedValue('fcm-token-driver-3');
      sendToToken.mockRejectedValue(new Error('FCM caído'));

      await expect(
        service.sendOfferPushToDriver('driver-3', 'order-1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('sendOrderConfirmation', () => {
    it('usa el token del cliente y devuelve el messageId', async () => {
      customers.findNotificationToken.mockResolvedValue({
        esCliente: true,
        token: 'fcm-token-customer',
      });

      const result = await service.sendOrderConfirmation(
        'customer-1',
        'order-abcdef123',
      );

      expect(sendToToken).toHaveBeenCalledWith(
        'fcm-token-customer',
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'ORDER_CONFIRMATION',
          }) as unknown,
        }),
      );
      expect(result).toEqual({ success: true, messageId: 'msg-1' });
    });

    it('sin token, no manda push y lo informa', async () => {
      customers.findNotificationToken.mockResolvedValue({
        esCliente: true,
        token: null,
      });

      const result = await service.sendOrderConfirmation('c2', 'order-1');

      expect(sendToToken).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
        error: 'No notification token',
      });
    });

    it('si el usuario no es cliente, lo informa', async () => {
      customers.findNotificationToken.mockResolvedValue({
        esCliente: false,
        token: null,
      });
      await expect(
        service.sendOrderConfirmation('u9', 'order-1'),
      ).resolves.toEqual({ success: false, error: 'Customer not found' });
    });
  });

  describe('reenviarConfirmacion (super admin)', () => {
    it('un cliente que no existe es 404 y no manda nada', async () => {
      orders.findRef.mockResolvedValue({ customerId: 'u9' });
      customers.findNotificationToken.mockResolvedValue({
        esCliente: false,
        token: null,
      });
      await expect(
        service.reenviarConfirmacion('u9', 'order-1', 'd1'),
      ).rejects.toThrow(new NotFoundException('Cliente no encontrado'));
      expect(sendToToken).not.toHaveBeenCalled();
    });

    it('un cliente que existe recibe la confirmación', async () => {
      customers.findNotificationToken.mockResolvedValue({
        esCliente: true,
        token: 'fcm-token-customer',
      });
      await expect(
        service.reenviarConfirmacion('c1', 'order-abcdef123', 'd1'),
      ).resolves.toEqual({ success: true, messageId: 'msg-1' });
    });

    it.each([
      [
        'cliente de otra distribuidora',
        () =>
          customers.assertDeLaDistribuidora.mockRejectedValue(
            new NotFoundException('Cliente no encontrado'),
          ),
      ],
      [
        'pedido de otra distribuidora',
        () => orders.findRef.mockResolvedValue(null),
      ],
    ])('%s da 404 y no manda el push', async (_caso, preparar) => {
      preparar();
      await expect(
        service.reenviarConfirmacion('c1', 'order-abcdef123', 'd1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(sendToToken).not.toHaveBeenCalled();
    });
  });

  describe('sendArrivalPushToCustomer (dice si el push salió)', () => {
    it('sent: manda ORDER_ARRIVED al token del cliente y FCM devuelve el id', async () => {
      customers.findNotificationToken.mockResolvedValue({ token: 'fcm-c' });
      await expect(
        service.sendArrivalPushToCustomer('c1', 'o1', 'Ana'),
      ).resolves.toBe('sent');
      expect(sendToToken).toHaveBeenCalledWith(
        'fcm-c',
        expect.objectContaining({
          data: { event: 'ORDER_ARRIVED', orderId: 'o1' },
          notification: expect.objectContaining({
            body: 'Ana está en la puerta.',
          }) as unknown,
        }),
      );
    });

    it('no_token: el cliente no registró dispositivo, no se manda nada', async () => {
      customers.findNotificationToken.mockResolvedValue({ token: null });
      await expect(
        service.sendArrivalPushToCustomer('c1', 'o1', 'Ana'),
      ).resolves.toBe('no_token');
      expect(sendToToken).not.toHaveBeenCalled();
    });

    it('failed: FCM falla, no lanza', async () => {
      customers.findNotificationToken.mockResolvedValue({ token: 'fcm-c' });
      sendToToken.mockRejectedValue(new Error('FCM caído'));
      await expect(
        service.sendArrivalPushToCustomer('c1', 'o1', 'Ana'),
      ).resolves.toBe('failed');
    });

    it('failed: FCM no confirmó a tiempo (el adaptador devuelve sin id)', async () => {
      customers.findNotificationToken.mockResolvedValue({ token: 'fcm-c' });
      sendToToken.mockResolvedValue('');
      await expect(
        service.sendArrivalPushToCustomer('c1', 'o1', 'Ana'),
      ).resolves.toBe('failed');
    });

    it('failed: no se pudo leer el token, no lanza', async () => {
      customers.findNotificationToken.mockRejectedValue(new Error('base'));
      await expect(
        service.sendArrivalPushToCustomer('c1', 'o1', 'Ana'),
      ).resolves.toBe('failed');
    });
  });

  describe('sendPaymentApprovedPush', () => {
    beforeEach(() => {
      customers.findNotificationToken.mockResolvedValue({
        esCliente: true,
        token: 'fcm-token-customer',
      });
    });

    it('un pago manda "Pago aprobado" con el evento PAYMENT_APPROVED', async () => {
      await service.sendPaymentApprovedPush('customer-1', 'order-abcdef123');
      expect(sendToToken).toHaveBeenCalledWith(
        'fcm-token-customer',
        expect.objectContaining({
          notification: expect.objectContaining({
            title: 'Pago aprobado',
            body: 'Recibimos el pago de tu pedido #order-ab.',
          }) as unknown,
          data: { event: 'PAYMENT_APPROVED', orderId: 'order-abcdef123' },
        }),
      );
    });

    it('una seña manda el texto de la reserva y el evento DEPOSIT_APPROVED', async () => {
      await service.sendPaymentApprovedPush(
        'customer-1',
        'order-abcdef123',
        true,
      );
      expect(sendToToken).toHaveBeenCalledWith(
        'fcm-token-customer',
        expect.objectContaining({
          notification: expect.objectContaining({
            body: 'Recibimos la seña de tu reserva #order-ab.',
          }) as unknown,
          data: { event: 'DEPOSIT_APPROVED', orderId: 'order-abcdef123' },
        }),
      );
    });

    it('sin token no manda nada y no lanza', async () => {
      customers.findNotificationToken.mockResolvedValue({
        esCliente: true,
        token: null,
      });
      await expect(
        service.sendPaymentApprovedPush('customer-1', 'o1'),
      ).resolves.toBeUndefined();
      expect(sendToToken).not.toHaveBeenCalled();
    });

    it('si FCM falla no lanza', async () => {
      sendToToken.mockRejectedValue(new Error('fcm caído'));
      await expect(
        service.sendPaymentApprovedPush('customer-1', 'o1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('saveNotificationToken', () => {
    it('lo guarda como cliente si lo es', async () => {
      customers.saveNotificationToken.mockResolvedValue(true);
      await expect(
        service.saveNotificationToken('u1', 't', 'android'),
      ).resolves.toEqual({ success: true });
      expect(deliveries.saveNotificationToken).not.toHaveBeenCalled();
    });

    it('si no es cliente, lo guarda como chofer', async () => {
      customers.saveNotificationToken.mockResolvedValue(false);
      deliveries.saveNotificationToken.mockResolvedValue(true);
      await expect(
        service.saveNotificationToken('u1', 't', 'android'),
      ).resolves.toEqual({ success: true });
    });

    it('si no es ninguno de los dos, lo informa', async () => {
      customers.saveNotificationToken.mockResolvedValue(false);
      deliveries.saveNotificationToken.mockResolvedValue(false);
      await expect(
        service.saveNotificationToken('u1', 't', 'android'),
      ).resolves.toEqual({ success: false, error: 'User not found' });
    });
  });
});
