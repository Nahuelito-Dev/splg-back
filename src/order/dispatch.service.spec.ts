import { DispatchService } from './dispatch.service';
import { Order } from './entities/order.entity';

/**
 * Cron del despacho: solo el reloj + lock. La lógica de a-quién-ofrecer vive en
 * el orquestador (mockeado). Verificamos el lock distribuido, que vence ofertas
 * y arranca pendientes sin oferta, y que saltea pedidos recién creados.
 */
describe('DispatchService', () => {
  let service: DispatchService;
  let orderService: {
    findAvailableOrders: jest.Mock;
    distribuidorasConPedidosDisponibles: jest.Mock;
  };
  let redis: { acquireLock: jest.Mock };
  let orchestrator: {
    handleExpiredOffers: jest.Mock;
    ensureOffered: jest.Mock;
    distribuidorasConOfertasVencidas: jest.Mock;
  };
  let lock: { release: jest.Mock };
  let frecuencias: {
    distribuidorasQueCorren: jest.Mock;
    liberarMarca: jest.Mock;
  };

  const OLD = new Date(Date.now() - 5 * 60 * 1000);
  const NEW = new Date();

  const makeOrder = (over: Partial<Order> = {}): Order =>
    ({ orderId: 'ord-1', createdAt: OLD, ...over }) as unknown as Order;

  beforeEach(() => {
    lock = { release: jest.fn().mockResolvedValue(undefined) };
    orderService = {
      findAvailableOrders: jest.fn().mockResolvedValue({ orders: [] }),
      distribuidorasConPedidosDisponibles: jest.fn().mockResolvedValue([]),
    };
    redis = { acquireLock: jest.fn().mockResolvedValue(lock) };
    orchestrator = {
      handleExpiredOffers: jest.fn().mockResolvedValue(undefined),
      ensureOffered: jest.fn().mockResolvedValue(undefined),
      distribuidorasConOfertasVencidas: jest.fn().mockResolvedValue([]),
    };
    frecuencias = {
      distribuidorasQueCorren: jest.fn((_t: string, ids: string[]) =>
        Promise.resolve(new Set(ids)),
      ),
      liberarMarca: jest.fn().mockResolvedValue(undefined),
    };
    service = new DispatchService(
      orderService as unknown as import('./order.service').OrderService,
      redis as unknown as import('../redis/redis.service').RedisService,
      orchestrator as unknown as import('./application/dispatch-orchestrator.service').DispatchOrchestratorService,
      frecuencias as unknown as import('../distributor/scheduled-tasks-settings.service').ScheduledTasksSettingsService,
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

  /** Una distribuidora con pedidos pendientes (para que el tic la atienda). */
  const conPendientes = (...ids: string[]) =>
    orderService.distribuidorasConPedidosDisponibles.mockResolvedValue(ids);

  it('arranca pedidos pendientes viejos sin oferta (ensureOffered)', async () => {
    conPendientes('d1');
    orderService.findAvailableOrders.mockResolvedValue({
      orders: [makeOrder({ orderId: 'a' }), makeOrder({ orderId: 'b' })],
    });
    await service.tick();
    expect(orchestrator.ensureOffered).toHaveBeenCalledTimes(2);
  });

  it('saltea pedidos creados hace menos de 1 minuto', async () => {
    conPendientes('d1');
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

  describe('CU-173: frecuencia por distribuidora', () => {
    it('al empezar decide, de una pasada, qué distribuidoras con trabajo corren, y se lo pasa al orquestador', async () => {
      orchestrator.distribuidorasConOfertasVencidas.mockResolvedValue(['d1']);
      conPendientes('d1', 'd2');

      await service.tick();

      expect(frecuencias.distribuidorasQueCorren).toHaveBeenCalledTimes(1);
      expect(frecuencias.distribuidorasQueCorren).toHaveBeenCalledWith(
        'dispatchRetrySeconds',
        ['d1', 'd2'],
      );
      expect(orchestrator.handleExpiredOffers).toHaveBeenCalledWith(
        new Set(['d1', 'd2']),
      );
    });

    it('consulta los pendientes de cada distribuidora que corre, con su propio límite', async () => {
      conPendientes('d1', 'd2');
      frecuencias.distribuidorasQueCorren.mockResolvedValue(new Set(['d2']));

      await service.tick();

      expect(orderService.findAvailableOrders).toHaveBeenCalledTimes(1);
      expect(orderService.findAvailableOrders).toHaveBeenCalledWith(
        { limit: 50, offset: 0 },
        'd2',
        // El cron sí incluye los express: el pool del chofer no, el despacho sí.
        true,
      );
    });

    it('si el tic falla, devuelve la marca de las distribuidoras que tenía asignadas', async () => {
      conPendientes('d1', 'd2');
      orchestrator.handleExpiredOffers.mockRejectedValue(new Error('boom'));

      await service.tick();

      expect(frecuencias.liberarMarca).toHaveBeenCalledWith(
        'dispatchRetrySeconds',
        'd1',
      );
      expect(frecuencias.liberarMarca).toHaveBeenCalledWith(
        'dispatchRetrySeconds',
        'd2',
      );
    });
  });
});
