import { NotFoundException } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { FcmPort } from '../firebase/ports/fcm.port';
import { CustomersService } from '../customer/customer.service';
import { DeliveryService } from '../delivery/delivery.service';

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
  };
  let deliveries: {
    findNotificationToken: jest.Mock;
    saveNotificationToken: jest.Mock;
  };
  let sendToToken: jest.Mock;

  beforeEach(() => {
    customers = {
      findNotificationToken: jest.fn(),
      saveNotificationToken: jest.fn(),
    };
    deliveries = {
      findNotificationToken: jest.fn(),
      saveNotificationToken: jest.fn(),
    };
    sendToToken = jest.fn().mockResolvedValue('msg-1');

    service = new NotificationsService(
      customers as unknown as CustomersService,
      deliveries as unknown as DeliveryService,
      { sendToToken } as unknown as FcmPort,
    );
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
      customers.findNotificationToken.mockResolvedValue({
        esCliente: false,
        token: null,
      });
      await expect(
        service.reenviarConfirmacion('u9', 'order-1'),
      ).rejects.toThrow(new NotFoundException('Cliente no encontrado'));
      expect(sendToToken).not.toHaveBeenCalled();
    });

    it('un cliente que existe recibe la confirmación', async () => {
      customers.findNotificationToken.mockResolvedValue({
        esCliente: true,
        token: 'fcm-token-customer',
      });
      await expect(
        service.reenviarConfirmacion('c1', 'order-abcdef123'),
      ).resolves.toEqual({ success: true, messageId: 'msg-1' });
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
