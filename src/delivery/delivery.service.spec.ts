// El constructor de DeliveryService hace firebase.initializeApp('delivery-service').
// Lo mockeamos para poder instanciar el servicio en los tests sin credenciales
// reales y sin el error "app already exists" al crear más de una instancia.
jest.mock('firebase-admin', () => ({
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
}));

import { DeliveryService } from './delivery.service';

/**
 * Cubre el fix de CU-022: al ponerse OFFLINE, el chofer debe salir del radar
 * Redis. El radar (`drivers:locations`) se llena por `user_id` (lo setea
 * `driver:update-location` vía `updateDriverLocation(userId,...)`), así que el
 * `removeDriver` tiene que usar `user_id`. Antes usaba `delivery_id` → ZREM
 * no-op → el chofer offline seguía recibiendo ofertas.
 */
describe('DeliveryService.toggleAvailability (CU-022)', () => {
  let service: DeliveryService;
  let deliveryRepo: { findOne: jest.Mock; save: jest.Mock };
  let redis: { removeDriver: jest.Mock };

  beforeEach(() => {
    deliveryRepo = {
      findOne: jest.fn().mockResolvedValue({
        user_id: 'user-123',
        delivery_id: 'delivery-999',
        isActive: true,
      }),
      save: jest.fn().mockImplementation((d) => Promise.resolve(d)),
    };
    redis = { removeDriver: jest.fn().mockResolvedValue(undefined) };
    service = new DeliveryService(
      deliveryRepo as any, // deliveryRepository
      redis as any, // redisService
      {} as any, // userRepository (no usado en este caso)
      {} as any, // roleRepository (no usado en este caso)
      {} as any, // dataSource (no usado en este caso)
      {} as any, // firebaseAuth (no usado en este caso)
    );
  });

  it('al ponerse OFFLINE saca al chofer del radar por user_id (NO delivery_id)', async () => {
    await service.toggleAvailability('user-123', false);
    expect(redis.removeDriver).toHaveBeenCalledWith('user-123');
    expect(redis.removeDriver).not.toHaveBeenCalledWith('delivery-999');
  });

  it('al ponerse ONLINE no toca el radar', async () => {
    await service.toggleAvailability('user-123', true);
    expect(redis.removeDriver).not.toHaveBeenCalled();
  });
});
