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
    notifyAdmins: jest.Mock;
  };
  let redis: {
    withLock: jest.Mock;
    setIfAbsent: jest.Mock;
    del: jest.Mock;
  };
  let orders: { findByIdFull: jest.Mock };
  let deliveries: { choferesElegibles: jest.Mock };
  let fleet: { choferesInhabilitados: jest.Mock };
  let truckGate: { choferesQuePuedenRecibir: jest.Mock };
  let offers: {
    create: jest.Mock;
    findDriverOfferState: jest.Mock;
    hasActiveOffer: jest.Mock;
    findExpired: jest.Mock;
    updateStatus: jest.Mock;
    closeActiveOffer: jest.Mock;
    recordDriverHeldOrder: jest.Mock;
  };

  const estado = (blocked: string[], reofferable: string[] = []) => ({
    blocked,
    reofferable,
  });

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
      notifyAdmins: jest.fn(),
    };
    redis = {
      withLock: jest.fn(
        async (_k: string, _ttl: number, fn: () => unknown) => ({
          obtenido: true,
          valor: await fn(),
        }),
      ),
      setIfAbsent: jest.fn().mockResolvedValue(true),
      del: jest.fn().mockResolvedValue(undefined),
    };
    orders = { findByIdFull: jest.fn().mockResolvedValue(makeOrder()) };
    offers = {
      create: jest.fn().mockResolvedValue({} as DispatchOffer),
      findDriverOfferState: jest
        .fn()
        .mockResolvedValue({ blocked: [], reofferable: [] }),
      hasActiveOffer: jest.fn().mockResolvedValue(false),
      findExpired: jest.fn().mockResolvedValue([]),
      updateStatus: jest.fn().mockResolvedValue(undefined),
      closeActiveOffer: jest.fn().mockResolvedValue(true),
      recordDriverHeldOrder: jest.fn().mockResolvedValue(undefined),
    };
    deliveries = {
      choferesElegibles: jest.fn((ids: string[]) => Promise.resolve(ids)),
    };
    fleet = {
      choferesInhabilitados: jest.fn().mockResolvedValue(new Set()),
    };
    truckGate = {
      // Por defecto todos los candidatos pueden trabajar.
      choferesQuePuedenRecibir: jest.fn((_dist: string, ids: string[]) =>
        Promise.resolve(new Set(ids)),
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
      fleet as unknown as import('../../fleet/fleet-dispatch-lock.service').FleetDispatchLockService,
      redis as unknown as import('../../redis/redis.service').RedisService,
      truckGate as unknown as import('../domain/ports/truck-load-gate.port').TruckLoadGatePort,
    );
  });

  describe('offerToNextDriver · carga del camión', () => {
    const conTenant = () => makeOrder({ distributorId: 'dist-1' });

    it('ofrece al más cercano QUE PUEDE recibir (según su carga), salteando al que no', async () => {
      dispatch.findNearbyDrivers.mockResolvedValueOnce([
        'sin-carga',
        'en-ruta',
      ]);
      truckGate.choferesQuePuedenRecibir.mockResolvedValue(
        new Set(['en-ruta']),
      );

      const result = await orchestrator.offerToNextDriver(conTenant());

      expect(result).toBe('en-ruta');
      expect(truckGate.choferesQuePuedenRecibir).toHaveBeenCalledWith(
        'dist-1',
        ['sin-carga', 'en-ruta'],
      );
    });

    it('si nadie puede recibir, no ofrece a nadie', async () => {
      dispatch.findNearbyDrivers.mockResolvedValue(['a', 'b']);
      truckGate.choferesQuePuedenRecibir.mockResolvedValue(new Set());

      expect(await orchestrator.offerToNextDriver(conTenant())).toBeNull();
      expect(offers.create).not.toHaveBeenCalled();
    });

    it('si todos pueden, ofrece al más cercano', async () => {
      dispatch.findNearbyDrivers.mockResolvedValueOnce(['a', 'b']);

      expect(await orchestrator.offerToNextDriver(conTenant())).toBe('a');
    });
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
      offers.findDriverOfferState.mockResolvedValue(estado(['d1']));
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
      offers.findDriverOfferState.mockResolvedValue(estado(['d1']));
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
      offers.findDriverOfferState.mockResolvedValue(estado([]));
      // findNearbyDrivers siempre [] (default)
      const result = await orchestrator.offerToNextDriver(makeOrder());

      expect(result).toBeNull();
      expect(offers.create).not.toHaveBeenCalled();
      expect(dispatch.notifyDriverNewOrder).not.toHaveBeenCalled();
      expect(dispatch.findNearbyDrivers).toHaveBeenCalledTimes(4); // agotó 5,10,15,20
    });

    it('mide contra el punto FRESCO del pedido, no contra el objeto recibido', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder());
      await orchestrator.offerToNextDriver(makeOrder({ deliveryPoint: null }));
      expect(dispatch.findNearbyDrivers).toHaveBeenCalledWith(-26.8, -65.2, 5);
    });

    it('sin punto de entrega no busca choferes (no mide contra 0,0)', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder({ deliveryPoint: null }));
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

    it('el radar no filtra por habilitación: el orquestador descarta al no elegible y ofrece al que sí lo es', async () => {
      // El más cercano ('near') está en el radar pero deshabilitado o sin
      // validar; DeliveryService.choferesElegibles lo saca de la lista.
      dispatch.findNearbyDrivers.mockResolvedValueOnce(['near', 'far']);
      deliveries.choferesElegibles.mockResolvedValueOnce(['far']);

      const result = await orchestrator.offerToNextDriver(makeOrder());

      expect(result).toBe('far');
      expect(deliveries.choferesElegibles).toHaveBeenCalledWith(
        ['near', 'far'],
        undefined,
      );
    });

    it('CU-136/137/138: saltea al chofer inhabilitado por flota (licencia/vehículo vencido) y ofrece al siguiente', async () => {
      dispatch.findNearbyDrivers.mockResolvedValueOnce(['near', 'far']);
      fleet.choferesInhabilitados.mockResolvedValueOnce(new Set(['near']));

      const result = await orchestrator.offerToNextDriver(makeOrder());

      expect(result).toBe('far');
      expect(fleet.choferesInhabilitados).toHaveBeenCalledWith(
        ['near', 'far'],
        undefined,
      );
    });

    it('CU-136/137/138: si TODOS los candidatos elegibles están inhabilitados por flota, no ofrece nada', async () => {
      dispatch.findNearbyDrivers.mockResolvedValue(['near']);
      fleet.choferesInhabilitados.mockResolvedValue(new Set(['near']));

      const result = await orchestrator.offerToNextDriver(makeOrder());

      expect(result).toBeNull();
      expect(offers.create).not.toHaveBeenCalled();
      // El mismo chofer reaparece en los 4 radios; el bloqueo de flota se
      // pregunta una sola vez por intento de oferta (punto 6 de la revisión).
      expect(fleet.choferesInhabilitados).toHaveBeenCalledTimes(1);
    });

    it('CU-136/137/138 (revisión): el bloqueo de flota se calcula UNA VEZ por chofer en todo el intento de oferta, no una vez por radio', async () => {
      // 'near' reaparece en el radio de 10km (superconjunto del de 5km),
      // pero ya fue evaluado y descartado: no se vuelve a consultar.
      dispatch.findNearbyDrivers
        .mockResolvedValueOnce(['near']) // 5km: sólo el bloqueado
        .mockResolvedValueOnce(['near', 'far']); // 10km: aparece uno nuevo
      fleet.choferesInhabilitados.mockResolvedValueOnce(new Set(['near']));

      const result = await orchestrator.offerToNextDriver(makeOrder());

      expect(result).toBe('far');
      expect(fleet.choferesInhabilitados).toHaveBeenCalledTimes(2);
      expect(fleet.choferesInhabilitados).toHaveBeenNthCalledWith(
        1,
        ['near'],
        undefined,
      );
      // La segunda consulta sólo pregunta por el candidato NUEVO ('far'):
      // 'near' no se repite aunque el radar lo vuelva a traer.
      expect(fleet.choferesInhabilitados).toHaveBeenNthCalledWith(
        2,
        ['far'],
        undefined,
      );
    });
  });

  describe('re-oferta de ofertas vencidas y aviso sin choferes', () => {
    it('prefiere a un chofer nunca contactado antes que a uno re-ofertable', async () => {
      offers.findDriverOfferState.mockResolvedValue(estado([], ['venció']));
      dispatch.findNearbyDrivers.mockResolvedValue(['venció', 'nuevo']);

      const result = await orchestrator.offerToNextDriver(makeOrder());

      expect(result).toBe('nuevo');
    });

    it('re-ofrece al que dejó vencer (pasado el cooldown) si no hay choferes nuevos', async () => {
      offers.findDriverOfferState.mockResolvedValue(estado([], ['venció']));
      dispatch.findNearbyDrivers.mockResolvedValue(['venció']);

      const result = await orchestrator.offerToNextDriver(makeOrder());

      expect(result).toBe('venció');
      expect(offers.findDriverOfferState).toHaveBeenCalledWith(
        'ord-1',
        expect.any(Date),
        DispatchOrchestratorService.REOFFER_COOLDOWN_MS,
        DispatchOrchestratorService.MAX_REOFERTAS_POR_CHOFER,
      );
      expect(redis.setIfAbsent).not.toHaveBeenCalled();
    });

    it('NUNCA re-ofrece a quien rechazó (o está en cooldown): no hay oferta y avisa a los admins', async () => {
      offers.findDriverOfferState.mockResolvedValue(estado(['rechazó']));
      dispatch.findNearbyDrivers.mockResolvedValue(['rechazó']);

      const result = await orchestrator.offerToNextDriver(
        makeOrder({ distributorId: 'dist-1' }),
      );

      expect(result).toBeNull();
      expect(offers.create).not.toHaveBeenCalled();
      expect(dispatch.notifyAdmins).toHaveBeenCalledWith(
        'order:no-drivers',
        expect.objectContaining({
          orderId: 'ord-1',
          reason: 'all_drivers_exhausted',
        }),
        'dist-1',
      );
    });

    it('sin choferes en el radar el motivo es no_drivers_in_range', async () => {
      await orchestrator.offerToNextDriver(makeOrder());

      expect(dispatch.notifyAdmins).toHaveBeenCalledWith(
        'order:no-drivers',
        expect.objectContaining({ reason: 'no_drivers_in_range' }),
        undefined,
      );
    });

    it('avisa UNA sola vez por agotamiento: si la marca ya existe no vuelve a emitir', async () => {
      redis.setIfAbsent.mockResolvedValue(false);

      await orchestrator.offerToNextDriver(makeOrder());

      expect(dispatch.notifyAdmins).not.toHaveBeenCalled();
    });

    it('una oferta a un chofer nuevo borra la marca; una re-oferta no', async () => {
      dispatch.findNearbyDrivers.mockResolvedValue(['nuevo']);
      await orchestrator.offerToNextDriver(makeOrder());
      expect(redis.del).toHaveBeenCalledWith('dispatch:no-drivers:ord-1');

      redis.del.mockClear();
      offers.findDriverOfferState.mockResolvedValue(estado([], ['nuevo']));
      await orchestrator.offerToNextDriver(makeOrder());
      expect(redis.del).not.toHaveBeenCalled();
    });

    it('no crea una segunda oferta si el pedido ya tiene una OFFERED vigente', async () => {
      offers.hasActiveOffer.mockResolvedValue(true);
      dispatch.findNearbyDrivers.mockResolvedValue(['d1']);

      const result = await orchestrator.offerToNextDriver(makeOrder());

      expect(result).toBeNull();
      expect(offers.create).not.toHaveBeenCalled();
      expect(dispatch.notifyAdmins).not.toHaveBeenCalled();
    });

    it('si el pedido ya no está PENDING dentro del lock (aceptado/asignado/cancelado), no ofrece ni emite NEW_ORDER', async () => {
      orders.findByIdFull.mockResolvedValue(
        makeOrder({ status: OrderStatus.ACCEPTED, deliveryId: 'drv-x' }),
      );
      dispatch.findNearbyDrivers.mockResolvedValue(['d1']);

      const result = await orchestrator.offerToNextDriver(makeOrder());

      expect(result).toBeNull();
      expect(offers.create).not.toHaveBeenCalled();
      expect(dispatch.notifyDriverNewOrder).not.toHaveBeenCalled();
    });

    it('si el pedido se borró dentro del lock, no ofrece', async () => {
      orders.findByIdFull.mockResolvedValue(null);
      const result = await orchestrator.offerToNextDriver(makeOrder());
      expect(result).toBeNull();
      expect(offers.create).not.toHaveBeenCalled();
    });

    it('motivo exacto: si ahora hay choferes elegibles en rango (todos excluidos) es all_drivers_exhausted, aunque no haya contactados bloqueados', async () => {
      offers.findDriverOfferState.mockResolvedValue(estado(['rechazó']));
      dispatch.findNearbyDrivers.mockResolvedValue(['rechazó']);
      await orchestrator.offerToNextDriver(makeOrder());
      expect(dispatch.notifyAdmins).toHaveBeenCalledWith(
        'order:no-drivers',
        expect.objectContaining({ reason: 'all_drivers_exhausted' }),
        undefined,
      );
    });

    it('motivo exacto: hubo contactados pero ahora no hay ningún chofer en rango => no_drivers_in_range', async () => {
      offers.findDriverOfferState.mockResolvedValue(estado(['rechazó']));
      // radar vacío
      await orchestrator.offerToNextDriver(makeOrder());
      expect(dispatch.notifyAdmins).toHaveBeenCalledWith(
        'order:no-drivers',
        expect.objectContaining({ reason: 'no_drivers_in_range' }),
        undefined,
      );
    });

    it('sin punto de entrega emite order:no-drivers con no_delivery_point (una vez)', async () => {
      orders.findByIdFull.mockResolvedValue(makeOrder({ deliveryPoint: null }));
      await orchestrator.offerToNextDriver(makeOrder({ deliveryPoint: null }));
      expect(dispatch.notifyAdmins).toHaveBeenCalledWith(
        'order:no-drivers',
        expect.objectContaining({ reason: 'no_delivery_point' }),
        undefined,
      );

      dispatch.notifyAdmins.mockClear();
      redis.setIfAbsent.mockResolvedValue(false);
      await orchestrator.offerToNextDriver(makeOrder({ deliveryPoint: null }));
      expect(dispatch.notifyAdmins).not.toHaveBeenCalled();
    });

    it('si otro proceso tiene el lock del pedido, no ofrece', async () => {
      redis.withLock.mockResolvedValue({ obtenido: false });
      dispatch.findNearbyDrivers.mockResolvedValue(['d1']);

      const result = await orchestrator.offerToNextDriver(makeOrder());

      expect(result).toBeNull();
      expect(offers.create).not.toHaveBeenCalled();
    });

    it('propaga el error si falla la creación de la oferta', async () => {
      dispatch.findNearbyDrivers.mockResolvedValue(['d1']);
      offers.create.mockRejectedValue(new Error('db'));

      await expect(orchestrator.offerToNextDriver(makeOrder())).rejects.toThrow(
        'db',
      );
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
      offers.findDriverOfferState.mockResolvedValue(estado(['d1']));
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
    it('onDriverAccepted deja constancia ACCEPTED del chofer y limpia el aviso', async () => {
      await orchestrator.onDriverAccepted('ord-1', 'd1');
      expect(offers.recordDriverHeldOrder).toHaveBeenCalledWith('ord-1', 'd1');
      expect(redis.del).toHaveBeenCalledWith('dispatch:no-drivers:ord-1');
    });

    it('onOrderAssigned (asignación manual) registra al chofer asignado y limpia el aviso', async () => {
      await orchestrator.onOrderAssigned('ord-1', 'd1');
      expect(offers.recordDriverHeldOrder).toHaveBeenCalledWith('ord-1', 'd1');
      expect(redis.del).toHaveBeenCalledWith('dispatch:no-drivers:ord-1');
    });

    it('releaseOffer deja al chofer que lo tuvo como ACCEPTED (nunca se le re-ofrece) y limpia el aviso', async () => {
      await orchestrator.releaseOffer('ord-1', 'd1');
      expect(offers.recordDriverHeldOrder).toHaveBeenCalledWith('ord-1', 'd1');
      expect(offers.closeActiveOffer).not.toHaveBeenCalled();
      expect(redis.del).toHaveBeenCalledWith('dispatch:no-drivers:ord-1');
    });

    it('onOrderClosed borra la marca de sin choferes', async () => {
      await orchestrator.onOrderClosed('ord-1');
      expect(redis.del).toHaveBeenCalledWith('dispatch:no-drivers:ord-1');
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
