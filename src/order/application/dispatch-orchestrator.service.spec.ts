import { DispatchOrchestratorService } from './dispatch-orchestrator.service';
import { Order, OrderStatus } from '../entities/order.entity';
import {
  DispatchOffer,
  DispatchOfferStatus,
} from '../entities/dispatch-offer.entity';

/**
 * Despacho SECUENCIAL con timeout. Mockeamos el puerto de tiempo real, el repo de
 * pedidos y el de ofertas. Verificamos: ofrecer al más cercano no-contactado,
 * radio progresivo, TTL de 30s, vencimiento → siguiente, aceptar/rechazar.
 */
describe('DispatchOrchestratorService', () => {
  let orchestrator: DispatchOrchestratorService;
  let dispatch: {
    findNearbyDrivers: jest.Mock;
    notifyDriverNewOrder: jest.Mock;
  };
  let orders: { findByIdFull: jest.Mock };
  let offers: {
    create: jest.Mock;
    findOfferedDriverIds: jest.Mock;
    hasActiveOffer: jest.Mock;
    findExpired: jest.Mock;
    updateStatus: jest.Mock;
    closeActiveOffer: jest.Mock;
  };

  const makeOrder = (over: Partial<Order> = {}): Order =>
    ({
      orderId: 'ord-1',
      status: OrderStatus.PENDING,
      deliveryId: null,
      deliveryPoint: { type: 'Point', coordinates: [-65.2, -26.8] },
      totalAmount: 1000,
      items: [],
      ...over,
    }) as unknown as Order;

  beforeEach(() => {
    dispatch = {
      findNearbyDrivers: jest.fn().mockResolvedValue([]),
      notifyDriverNewOrder: jest.fn(),
    };
    orders = { findByIdFull: jest.fn() };
    offers = {
      create: jest.fn().mockResolvedValue({} as DispatchOffer),
      findOfferedDriverIds: jest.fn().mockResolvedValue([]),
      hasActiveOffer: jest.fn().mockResolvedValue(false),
      findExpired: jest.fn().mockResolvedValue([]),
      updateStatus: jest.fn().mockResolvedValue(undefined),
      closeActiveOffer: jest.fn().mockResolvedValue(true),
    };
    const deliveries = {
      choferesDeLaDistribuidora: jest.fn((ids: string[]) =>
        Promise.resolve(ids),
      ),
    };
    const notifications = {
      sendOfferPushToDriver: jest.fn().mockResolvedValue(undefined),
    };
    orchestrator = new DispatchOrchestratorService(
      dispatch as unknown as import('../domain/ports/realtime-dispatch.port').RealtimeDispatchPort,
      orders as unknown as import('../domain/ports/order.repository.port').OrderRepositoryPort,
      offers as unknown as import('../domain/ports/dispatch-offer.repository.port').DispatchOfferRepositoryPort,
      deliveries as unknown as import('../../delivery/delivery.service').DeliveryService,
      notifications as unknown as import('../../notifications/notifications.service').NotificationsService,
    );
  });

  describe('offerToNextDriver', () => {
    it('ofrece al chofer MÁS CERCANO (primero de la lista ASC) y crea la oferta con TTL 30s', async () => {
      dispatch.findNearbyDrivers.mockResolvedValueOnce(['near', 'far']);

      const before = Date.now();
      const result = await orchestrator.offerToNextDriver(makeOrder());

      expect(result).toBe('near');
      expect(offers.create).toHaveBeenCalledTimes(1);
      const [orderId, driverId, expiresAt] = offers.create.mock.calls[0] as [
        string,
        string,
        Date,
      ];
      expect(orderId).toBe('ord-1');
      expect(driverId).toBe('near');
      // expiresAt ≈ now + 30s
      const ttlMs = expiresAt.getTime() - before;
      expect(ttlMs).toBeGreaterThanOrEqual(29_000);
      expect(ttlMs).toBeLessThanOrEqual(31_000);
      expect(dispatch.notifyDriverNewOrder).toHaveBeenCalledWith(
        'near',
        expect.objectContaining({ event: 'NEW_ORDER', orderId: 'ord-1' }),
      );
    });

    it('SALTEA choferes ya contactados y ofrece al siguiente nuevo', async () => {
      offers.findOfferedDriverIds.mockResolvedValue(['d1']);
      dispatch.findNearbyDrivers.mockResolvedValueOnce(['d1', 'd2']);

      const result = await orchestrator.offerToNextDriver(makeOrder());

      expect(result).toBe('d2');
      expect(offers.create).toHaveBeenCalledWith(
        'ord-1',
        'd2',
        expect.any(Date),
        undefined,
      );
    });

    it('radio progresivo: si en 5km todos ya fueron contactados, amplía a 10km', async () => {
      offers.findOfferedDriverIds.mockResolvedValue(['d1']);
      dispatch.findNearbyDrivers
        .mockResolvedValueOnce(['d1']) // 5km: solo el ya contactado
        .mockResolvedValueOnce(['d1', 'd2']); // 10km: aparece uno nuevo

      const result = await orchestrator.offerToNextDriver(makeOrder());

      expect(result).toBe('d2');
      expect(dispatch.findNearbyDrivers).toHaveBeenNthCalledWith(
        1,
        -26.8,
        -65.2,
        5,
      );
      expect(dispatch.findNearbyDrivers).toHaveBeenNthCalledWith(
        2,
        -26.8,
        -65.2,
        10,
      );
    });

    it('devuelve null y no crea oferta si no hay choferes nuevos en ningún radio', async () => {
      offers.findOfferedDriverIds.mockResolvedValue([]);
      // findNearbyDrivers siempre [] (default)
      const result = await orchestrator.offerToNextDriver(makeOrder());

      expect(result).toBeNull();
      expect(offers.create).not.toHaveBeenCalled();
      expect(dispatch.notifyDriverNewOrder).not.toHaveBeenCalled();
      expect(dispatch.findNearbyDrivers).toHaveBeenCalledTimes(4); // agotó 5,10,15,20
    });

    it('sin punto de entrega no busca choferes (no mide contra 0,0)', async () => {
      const result = await orchestrator.offerToNextDriver(
        makeOrder({ deliveryPoint: null }),
      );

      expect(result).toBeNull();
      expect(dispatch.findNearbyDrivers).not.toHaveBeenCalled();
    });

    it('busca alrededor del punto de entrega, en latitud y longitud', async () => {
      await orchestrator.offerToNextDriver(makeOrder());

      expect(dispatch.findNearbyDrivers).toHaveBeenCalledWith(-26.8, -65.2, 5);
    });
  });

  describe('handleExpiredOffers', () => {
    const expiredOffer = (over = {}): DispatchOffer =>
      ({
        offerId: 'off-1',
        orderId: 'ord-1',
        driverId: 'd1',
        status: DispatchOfferStatus.OFFERED,
        ...over,
      }) as DispatchOffer;

    it('marca la oferta vencida EXPIRED y re-ofrece al siguiente si el pedido sigue pendiente', async () => {
      offers.findExpired.mockResolvedValue([expiredOffer()]);
      orders.findByIdFull.mockResolvedValue(makeOrder());
      offers.findOfferedDriverIds.mockResolvedValue(['d1']);
      dispatch.findNearbyDrivers.mockResolvedValueOnce(['d1', 'd2']);

      await orchestrator.handleExpiredOffers();

      expect(offers.updateStatus).toHaveBeenCalledWith(
        'off-1',
        DispatchOfferStatus.EXPIRED,
      );
      expect(offers.create).toHaveBeenCalledWith(
        'ord-1',
        'd2',
        expect.any(Date),
        undefined,
      );
    });

    it('NO re-ofrece si el pedido ya fue aceptado (tiene delivery asignado)', async () => {
      offers.findExpired.mockResolvedValue([expiredOffer()]);
      orders.findByIdFull.mockResolvedValue(
        makeOrder({ status: OrderStatus.ACCEPTED, deliveryId: 'drv-x' }),
      );

      await orchestrator.handleExpiredOffers();

      expect(offers.updateStatus).toHaveBeenCalledWith(
        'off-1',
        DispatchOfferStatus.EXPIRED,
      );
      expect(offers.create).not.toHaveBeenCalled();
    });

    it('NO re-ofrece si el pedido ya no existe', async () => {
      offers.findExpired.mockResolvedValue([expiredOffer()]);
      orders.findByIdFull.mockResolvedValue(null);

      await orchestrator.handleExpiredOffers();

      expect(offers.create).not.toHaveBeenCalled();
    });
  });

  describe('ensureOffered', () => {
    it('no ofrece si ya hay una oferta activa', async () => {
      offers.hasActiveOffer.mockResolvedValue(true);
      await orchestrator.ensureOffered(makeOrder());
      expect(offers.create).not.toHaveBeenCalled();
    });

    it('ofrece si el pedido está pendiente y sin oferta activa', async () => {
      offers.hasActiveOffer.mockResolvedValue(false);
      dispatch.findNearbyDrivers.mockResolvedValueOnce(['d1']);
      await orchestrator.ensureOffered(makeOrder());
      expect(offers.create).toHaveBeenCalledWith(
        'ord-1',
        'd1',
        expect.any(Date),
        undefined,
      );
    });

    it('no ofrece si el pedido no es re-ofrecible (ya asignado)', async () => {
      await orchestrator.ensureOffered(
        makeOrder({ status: OrderStatus.ACCEPTED, deliveryId: 'x' }),
      );
      expect(offers.hasActiveOffer).not.toHaveBeenCalled();
      expect(offers.create).not.toHaveBeenCalled();
    });
  });

  describe('onDriverAccepted / onDriverRejected', () => {
    it('onDriverAccepted cierra la oferta activa como ACCEPTED', async () => {
      await orchestrator.onDriverAccepted('ord-1', 'd1');
      expect(offers.closeActiveOffer).toHaveBeenCalledWith(
        'ord-1',
        'd1',
        DispatchOfferStatus.ACCEPTED,
      );
    });

    it('onDriverRejected cierra REJECTED y ofrece al siguiente', async () => {
      dispatch.findNearbyDrivers.mockResolvedValueOnce(['d2']);
      await orchestrator.onDriverRejected(makeOrder(), 'd1');
      expect(offers.closeActiveOffer).toHaveBeenCalledWith(
        'ord-1',
        'd1',
        DispatchOfferStatus.REJECTED,
      );
      expect(offers.create).toHaveBeenCalledWith(
        'ord-1',
        'd2',
        expect.any(Date),
        undefined,
      );
    });
  });
});
