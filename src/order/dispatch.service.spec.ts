import { DispatchService } from './dispatch.service';
import { Order } from './entities/order.entity';

/**
 * Cron del despacho: solo el reloj + lock. La lógica de a-quién-ofrecer vive en
 * el orquestador (mockeado). Verificamos el lock distribuido, que vence ofertas
 * y arranca pendientes sin oferta, y que saltea pedidos recién creados.
 */
describe('DispatchService', () => {
  let service: DispatchService;
  let orderService: { findAvailableOrders: jest.Mock };
  let redis: { acquireLock: jest.Mock };
  let orchestrator: {
    handleExpiredOffers: jest.Mock;
    ensureOffered: jest.Mock;
  };
  let lock: { release: jest.Mock };

  const OLD = new Date(Date.now() - 5 * 60 * 1000);
  const NEW = new Date();

  const makeOrder = (over: Partial<Order> = {}): Order =>
    ({ orderId: 'ord-1', createdAt: OLD, ...over }) as unknown as Order;

  beforeEach(() => {
    lock = { release: jest.fn().mockResolvedValue(undefined) };
    orderService = {
      findAvailableOrders: jest.fn().mockResolvedValue({ orders: [] }),
    };
    redis = { acquireLock: jest.fn().mockResolvedValue(lock) };
    orchestrator = {
      handleExpiredOffers: jest.fn().mockResolvedValue(undefined),
      ensureOffered: jest.fn().mockResolvedValue(undefined),
    };
    service = new DispatchService(
      orderService as unknown as import('./order.service').OrderService,
      redis as unknown as import('../redis/redis.service').RedisService,
      orchestrator as unknown as import('./application/dispatch-orchestrator.service').DispatchOrchestratorService,
    );
  });

  it('no hace nada si otra instancia tiene el lock', async () => {
    redis.acquireLock.mockResolvedValue(null);
    await service.tick();
    expect(orchestrator.handleExpiredOffers).not.toHaveBeenCalled();
    expect(orderService.findAvailableOrders).not.toHaveBeenCalled();
  });

  it('vence ofertas y libera el lock', async () => {
    await service.tick();
    expect(orchestrator.handleExpiredOffers).toHaveBeenCalled();
    expect(lock.release).toHaveBeenCalled();
  });

  it('arranca pedidos pendientes viejos sin oferta (ensureOffered)', async () => {
    orderService.findAvailableOrders.mockResolvedValue({
      orders: [makeOrder({ orderId: 'a' }), makeOrder({ orderId: 'b' })],
    });
    await service.tick();
    expect(orchestrator.ensureOffered).toHaveBeenCalledTimes(2);
  });

  it('saltea pedidos creados hace menos de 1 minuto', async () => {
    orderService.findAvailableOrders.mockResolvedValue({
      orders: [makeOrder({ createdAt: NEW })],
    });
    await service.tick();
    expect(orchestrator.ensureOffered).not.toHaveBeenCalled();
  });

  it('libera el lock aunque el orquestador falle', async () => {
    orchestrator.handleExpiredOffers.mockRejectedValue(new Error('boom'));
    await service.tick();
    expect(lock.release).toHaveBeenCalled();
  });
});
