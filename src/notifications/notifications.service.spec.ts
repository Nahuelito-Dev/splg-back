import { NotificationsService } from './notifications.service';
import { FcmPort } from '../firebase/ports/fcm.port';

/**
 * Antes de FirebaseModule/FcmPort, este service inicializaba una app de
 * Firebase en el constructor (`firebase.initializeApp(..., 'notification-service')`)
 * y para poder instanciarlo en tests había que `jest.mock('firebase-admin')`
 * a nivel de archivo. Ahora inyecta `FcmPort` (abstracción), así que se
 * testea con un mock plano, sin tocar el SDK ni el módulo global.
 */
describe('NotificationsService', () => {
  let service: NotificationsService;
  let deliveryRepo: { findOne: jest.Mock };
  let customerRepo: { findOne: jest.Mock };
  let fcm: jest.Mocked<FcmPort>;

  beforeEach(() => {
    deliveryRepo = { findOne: jest.fn() };
    customerRepo = { findOne: jest.fn() };
    fcm = { sendToToken: jest.fn().mockResolvedValue('msg-1') };

    service = new NotificationsService(
      {} as any,
      customerRepo as any,
      deliveryRepo as any,
      fcm,
    );
  });

  describe('sendOfferPushToDriver', () => {
    it('manda el push al token FCM del chofer con el evento NEW_ORDER', async () => {
      deliveryRepo.findOne.mockResolvedValue({
        user_id: 'driver-1',
        notification_token: 'fcm-token-driver',
      });

      await service.sendOfferPushToDriver('driver-1', 'order-99');

      expect(fcm.sendToToken).toHaveBeenCalledWith(
        'fcm-token-driver',
        expect.objectContaining({
          data: { event: 'NEW_ORDER', orderId: 'order-99' },
        }),
      );
    });

    it('no manda nada (no-op) si el chofer no tiene token FCM registrado', async () => {
      deliveryRepo.findOne.mockResolvedValue({
        user_id: 'driver-2',
        notification_token: null,
      });

      await service.sendOfferPushToDriver('driver-2', 'order-1');

      expect(fcm.sendToToken).not.toHaveBeenCalled();
    });

    it('nunca lanza: si el FcmPort falla, el dispatch no debe romperse', async () => {
      deliveryRepo.findOne.mockResolvedValue({
        user_id: 'driver-3',
        notification_token: 'fcm-token-driver-3',
      });
      fcm.sendToToken.mockRejectedValue(new Error('FCM caído'));

      await expect(
        service.sendOfferPushToDriver('driver-3', 'order-1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('sendOrderConfirmation', () => {
    it('usa el token del customer y devuelve el messageId del FcmPort', async () => {
      customerRepo.findOne.mockResolvedValue({
        user_id: 'customer-1',
        notification_token: 'fcm-token-customer',
        user: { email: 'test@test.com' },
      });

      const result = await service.sendOrderConfirmation(
        'customer-1',
        'order-abcdef123',
      );

      expect(fcm.sendToToken).toHaveBeenCalledWith(
        'fcm-token-customer',
        expect.objectContaining({
          data: expect.objectContaining({ type: 'ORDER_CONFIRMATION' }),
        }),
      );
      expect(result).toEqual({ success: true, messageId: 'msg-1' });
    });

    it('no manda push si el customer no tiene token de notificación', async () => {
      customerRepo.findOne.mockResolvedValue({
        user_id: 'customer-2',
        notification_token: null,
        user: { email: 'test2@test.com' },
      });

      const result = await service.sendOrderConfirmation(
        'customer-2',
        'order-1',
      );

      expect(fcm.sendToToken).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
        error: 'No notification token',
      });
    });
  });
});
