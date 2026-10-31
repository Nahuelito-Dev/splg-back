import { DispatchOrchestratorService } from './dispatch-orchestrator.service';
import { EVENTO_NOTIFICAR_ADMIN } from '../../common/events/notificar-admin.event';
import {
  Order,
  OrderDeliveryMode,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../entities/order.entity';
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
  let orders: {
    findByIdFull: jest.Mock;
    findById: jest.Mock;
    findDeliveryIdsWithOrderInProgress: jest.Mock;
  };
  let settings: { obtener: jest.Mock };
  let deliveries: {
    choferesElegibles: jest.Mock;
    findDeliveryIdsByUserIds: jest.Mock;
  };
  let fleet: { choferesInhabilitados: jest.Mock; choferesEnMoto: jest.Mock };
  let expressSettings: { obtener: jest.Mock };
  let expressDegrade: { pasarAlRepartoComun: jest.Mock };
  let events: { emit: jest.Mock };
  let truckGate: { choferesQuePuedenRecibir: jest.Mock };
  let offers: {
    create: jest.Mock;
    findDriverOfferState: jest.Mock;
    hasActiveOffer: jest.Mock;
    isInLiveBatch: jest.Mock;
    isHeldForBatching: jest.Mock;
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
    orders = {
      findByIdFull: jest.fn().mockResolvedValue(makeOrder()),
      findById: jest.fn().mockResolvedValue(makeOrder()),
      // Por defecto nadie está ocupado.
      findDeliveryIdsWithOrderInProgress: jest
        .fn()
        .mockResolvedValue(new Set<string>()),
    };
    settings = {
      obtener: jest.fn().mockResolvedValue({
        radiusStepsKm: [5, 10, 15, 20],
        offerTtlSeconds: 30,
      }),
    };
    offers = {
      create: jest.fn().mockResolvedValue({} as DispatchOffer),
      findDriverOfferState: jest
        .fn()
        .mockResolvedValue({ blocked: [], reofferable: [] }),
      hasActiveOffer: jest.fn().mockResolvedValue(false),
      isInLiveBatch: jest.fn().mockResolvedValue(false),
      isHeldForBatching: jest.fn().mockResolvedValue(false),
      findExpired: jest.fn().mockResolvedValue([]),
      updateStatus: jest.fn().mockResolvedValue(true),
      closeActiveOffer: jest.fn().mockResolvedValue(true),
      recordDriverHeldOrder: jest.fn().mockResolvedValue(undefined),
    };
    deliveries = {
      choferesElegibles: jest.fn((ids: string[]) => Promise.resolve(ids)),
      findDeliveryIdsByUserIds: jest.fn((ids: string[]) =>
        Promise.resolve(
          ids.map((id) => ({ userId: id, deliveryId: `d-${id}` })),
        ),
      ),
    };
    fleet = {
      choferesInhabilitados: jest.fn().mockResolvedValue(new Set()),
      // Por defecto todos los candidatos van en moto.
      choferesEnMoto: jest.fn((ids: string[]) => Promise.resolve(new Set(ids))),
    };
    expressSettings = {
      obtener: jest.fn().mockResolvedValue({
        maxRadiusKm: 5,
        offerTtlSeconds: 20,
      }),
    };
    events = { emit: jest.fn() };
    expressDegrade = {
      pasarAlRepartoComun: jest.fn().mockResolvedValue({ orderId: 'ord-1' }),
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
      settings as unknown as import('../../distributor/dispatch-settings.service').DispatchSettingsService,
      expressSettings as unknown as import('../../distributor/express-settings.service').ExpressSettingsService,
      expressDegrade as unknown as import('./express-degrade.service').ExpressDegradeService,
      events as unknown as import('@nestjs/event-emitter').EventEmitter2,
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

  describe('offerToNextDriver · ocupación', () => {
    const conTenant = () => makeOrder({ distributorId: 'dist-1' });

    it('no ofrece a un chofer con un pedido aceptado o en camino', async () => {
      dispatch.findNearbyDrivers.mockResolvedValueOnce(['ocupado', 'libre']);
      orders.findDeliveryIdsWithOrderInProgress.mockResolvedValue(
        new Set(['d-ocupado']),
      );

      expect(await orchestrator.offerToNextDriver(conTenant())).toBe('libre');
      expect(orders.findDeliveryIdsWithOrderInProgress).toHaveBeenCalledWith([
        'd-ocupado',
        'd-libre',
      ]);
    });

    it('si el único cercano está ocupado, no hay oferta', async () => {
      dispatch.findNearbyDrivers.mockResolvedValue(['ocupado']);
      orders.findDeliveryIdsWithOrderInProgress.mockResolvedValue(
        new Set(['d-ocupado']),
      );

      expect(await orchestrator.offerToNextDriver(conTenant())).toBeNull();
      expect(offers.create).not.toHaveBeenCalled();
    });
  });

  describe('despacho express (CU-149)', () => {
    const express = (over: Partial<Order> = {}) =>
      makeOrder({
        distributorId: 'dist-1',
        deliveryMode: OrderDeliveryMode.EXPRESS,
        paymentMethod: PaymentMethod.CASH,
        paymentStatus: PaymentStatus.PENDING,
        ...over,
      });

    beforeEach(() => {
      orders.findByIdFull.mockResolvedValue(express());
    });

    it('ofrece al chofer en moto más cercano, con la ventana y el radio express', async () => {
      dispatch.findNearbyDrivers.mockResolvedValue(['moto-1', 'moto-2']);

      const before = Date.now();
      const result = await orchestrator.offerToNextDriver(express());

      expect(result).toBe('moto-1');
      expect(dispatch.findNearbyDrivers).toHaveBeenCalledTimes(1);
      expect(dispatch.findNearbyDrivers).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(Number),
        5,
      );
      const expiresAt = (
        offers.create.mock.calls[0] as [string, string, Date]
      )[2];
      expect(expiresAt.getTime() - before).toBeLessThanOrEqual(21_000);
      expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(19_000);
      expect(dispatch.notifyDriverNewOrder).toHaveBeenCalledWith(
        'moto-1',
        expect.objectContaining({ deliveryMode: OrderDeliveryMode.EXPRESS }),
      );
      expect(expressDegrade.pasarAlRepartoComun).not.toHaveBeenCalled();
    });

    it('saltea al que no va en moto', async () => {
      dispatch.findNearbyDrivers.mockResolvedValue(['auto', 'moto']);
      fleet.choferesEnMoto.mockResolvedValue(new Set(['moto']));

      expect(await orchestrator.offerToNextDriver(express())).toBe('moto');
    });

    it('NO amplía el radio: sólo consulta el radio express', async () => {
      dispatch.findNearbyDrivers.mockResolvedValue([]);
      expressDegrade.pasarAlRepartoComun.mockResolvedValue(null);

      await orchestrator.offerToNextDriver(express());

      expect(dispatch.findNearbyDrivers).toHaveBeenCalledTimes(1);
    });

    it('no re-ofrece a quien ya la vio (ni aunque su oferta haya vencido): pasa al reparto común', async () => {
      dispatch.findNearbyDrivers
        .mockResolvedValueOnce(['moto-1'])
        .mockResolvedValue([]);
      offers.findDriverOfferState.mockResolvedValue(estado([], ['moto-1']));
      // Tras el pase el pedido ya es común y no hay nadie más cerca.
      orders.findByIdFull
        .mockResolvedValueOnce(express())
        .mockResolvedValueOnce(makeOrder({ distributorId: 'dist-1' }));

      await orchestrator.offerToNextDriver(express());

      expect(expressDegrade.pasarAlRepartoComun).toHaveBeenCalledWith('ord-1');
      expect(offers.create).not.toHaveBeenCalled();
    });

    it('sin motos cerca el pedido pasa al reparto común y sigue con el despacho normal', async () => {
      orders.findByIdFull
        .mockResolvedValueOnce(express())
        .mockResolvedValueOnce(
          makeOrder({
            distributorId: 'dist-1',
            deliveryMode: OrderDeliveryMode.STANDARD,
          }),
        );
      // Primera consulta (express): sin motos. Segunda (normal): hay un auto.
      dispatch.findNearbyDrivers
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(['auto']);

      const result = await orchestrator.offerToNextDriver(express());

      expect(expressDegrade.pasarAlRepartoComun).toHaveBeenCalledWith('ord-1');
      expect(result).toBe('auto');
    });

    it('si el pase no corresponde (otro lo aceptó o canceló) no ofrece nada', async () => {
      expressDegrade.pasarAlRepartoComun.mockResolvedValue(null);
      dispatch.findNearbyDrivers.mockResolvedValue([]);

      expect(await orchestrator.offerToNextDriver(express())).toBeNull();
      expect(offers.create).not.toHaveBeenCalled();
    });

    it('un express por MercadoPago sin pagar no se despacha ni se degrada', async () => {
      const sinPagar = express({
        paymentMethod: PaymentMethod.MERCADOPAGO,
        paymentStatus: PaymentStatus.PENDING,
      });
      orders.findByIdFull.mockResolvedValue(sinPagar);

      expect(await orchestrator.offerToNextDriver(sinPagar)).toBeNull();
      expect(dispatch.findNearbyDrivers).not.toHaveBeenCalled();
      expect(expressDegrade.pasarAlRepartoComun).not.toHaveBeenCalled();
    });

    it('un express por MercadoPago ya pagado sí se despacha', async () => {
      const pagado = express({
        paymentMethod: PaymentMethod.MERCADOPAGO,
        paymentStatus: PaymentStatus.PAID,
      });
      orders.findByIdFull.mockResolvedValue(pagado);
      dispatch.findNearbyDrivers.mockResolvedValue(['moto-1']);

      expect(await orchestrator.offerToNextDriver(pagado)).toBe('moto-1');
    });

    it('el vencimiento de la oferta express ofrece a la siguiente moto', async () => {
      orders.findByIdFull.mockResolvedValue(express());
      offers.findExpired.mockResolvedValue([
        {
          offerId: 'of-1',
          orderId: 'ord-1',
          driverId: 'moto-1',
          distributorId: 'dist-1',
        },
      ]);
      dispatch.findNearbyDrivers.mockResolvedValue(['moto-1', 'moto-2']);
      offers.findDriverOfferState.mockResolvedValue(estado(['moto-1']));

      await orchestrator.handleExpiredOffers();

      expect(offers.create).toHaveBeenCalledWith(
        'ord-1',
        'moto-2',
        expect.any(Date),
        'dist-1',
      );
    });

    it('las ofertas vencidas de un express se procesan aunque a su distribuidora no le toque el intervalo', async () => {
      orders.findById.mockResolvedValue(express());
      orders.findByIdFull.mockResolvedValue(express());
      offers.findExpired.mockResolvedValue([
        {
          offerId: 'of-1',
          orderId: 'ord-1',
          driverId: 'moto-1',
          distributorId: 'dist-1',
        },
        {
          offerId: 'of-2',
          orderId: 'ord-2',
          driverId: 'x',
          distributorId: 'dist-1',
        },
      ]);
      orders.findById.mockImplementation((id: string) =>
        Promise.resolve(id === 'ord-1' ? express() : makeOrder()),
      );
      dispatch.findNearbyDrivers.mockResolvedValue(['moto-1', 'moto-2']);
      offers.findDriverOfferState.mockResolvedValue(estado(['moto-1']));

      // A dist-1 no le toca ahora (conjunto vacío).
      await orchestrator.handleExpiredOffers(new Set());

      expect(offers.updateStatus).toHaveBeenCalledTimes(1);
      expect(offers.updateStatus).toHaveBeenCalledWith(
        'of-1',
        DispatchOfferStatus.EXPIRED,
      );
      expect(offers.create).toHaveBeenCalledWith(
        'ord-1',
        'moto-2',
        expect.any(Date),
        'dist-1',
      );
    });

    it('choferesEnMotoCerca respeta la habilitación de flota', async () => {
      dispatch.findNearbyDrivers.mockResolvedValue(['bloqueada', 'libre']);
      fleet.choferesInhabilitados.mockResolvedValue(new Set(['bloqueada']));

      expect(
        await orchestrator.choferesEnMotoCerca(-26.8, -65.2, 'dist-1', 5),
      ).toEqual(['libre']);
    });
  });

  describe('choferesElegiblesCerca (lo usa M4)', () => {
    it('busca con el mayor radio del despacho y devuelve sólo los habilitados, del más cercano al más lejano', async () => {
      dispatch.findNearbyDrivers.mockResolvedValueOnce(['a', 'b', 'c']);
      fleet.choferesInhabilitados.mockResolvedValueOnce(new Set(['b']));

      const r = await orchestrator.choferesElegiblesCerca(
        -26.8,
        -65.2,
        'dist-1',
      );

      expect(dispatch.findNearbyDrivers).toHaveBeenCalledWith(-26.8, -65.2, 20);
      expect(r).toEqual(['a', 'c']);
    });
  });

  describe('offerToNextDriver', () => {
    it('M4: una parada de un lote de recorrido vivo no se ofrece suelta', async () => {
      dispatch.findNearbyDrivers.mockResolvedValueOnce(['near']);
      offers.isInLiveBatch.mockResolvedValue(true);

      expect(await orchestrator.offerToNextDriver(makeOrder())).toBeNull();
      expect(offers.isInLiveBatch).toHaveBeenCalledWith('ord-1');
      expect(dispatch.findNearbyDrivers).not.toHaveBeenCalled();
      expect(offers.create).not.toHaveBeenCalled();
    });

    it('M4 encendido: un programado dentro del margen de espera no se ofrece suelto', async () => {
      dispatch.findNearbyDrivers.mockResolvedValueOnce(['near']);
      offers.isHeldForBatching.mockResolvedValue(true);

      expect(await orchestrator.offerToNextDriver(makeOrder())).toBeNull();
      expect(offers.isHeldForBatching).toHaveBeenCalledWith('ord-1');
      expect(offers.create).not.toHaveBeenCalled();
    });

    it('M4 apagado o fuera del margen: M1 ofrece el programado como siempre', async () => {
      dispatch.findNearbyDrivers.mockResolvedValueOnce(['near']);
      offers.isHeldForBatching.mockResolvedValue(false);

      expect(await orchestrator.offerToNextDriver(makeOrder())).toBe('near');
    });

    it('M4: si el lote se deshizo (ya no está en un lote vivo), el pedido se ofrece de nuevo', async () => {
      dispatch.findNearbyDrivers.mockResolvedValueOnce(['near']);
      offers.isInLiveBatch.mockResolvedValue(false);

      expect(await orchestrator.offerToNextDriver(makeOrder())).toBe('near');
      expect(offers.create).toHaveBeenCalledTimes(1);
    });

    it('F9: un pedido común de Mercado Pago sin pagar no se ofrece (se despacha al aprobarse el pago)', async () => {
      const sinPagar = makeOrder({
        paymentMethod: PaymentMethod.MERCADOPAGO,
        paymentStatus: PaymentStatus.PENDING,
        depositPaid: false,
      });
      orders.findByIdFull.mockResolvedValue(sinPagar);

      expect(await orchestrator.offerToNextDriver(sinPagar)).toBeNull();
      expect(dispatch.findNearbyDrivers).not.toHaveBeenCalled();
      expect(offers.create).not.toHaveBeenCalled();
    });

    it('F9: una reserva de Mercado Pago con la seña paga sí se ofrece', async () => {
      const conSena = makeOrder({
        paymentMethod: PaymentMethod.MERCADOPAGO,
        paymentStatus: PaymentStatus.PENDING,
        depositPaid: true,
      });
      orders.findByIdFull.mockResolvedValue(conSena);
      dispatch.findNearbyDrivers.mockResolvedValueOnce(['near']);

      expect(await orchestrator.offerToNextDriver(conSena)).toBe('near');
    });

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

    it('CU-171: la oferta vence con la ventana configurada de la distribuidora del pedido', async () => {
      settings.obtener.mockResolvedValue({
        radiusStepsKm: [5],
        offerTtlSeconds: 120,
      });
      dispatch.findNearbyDrivers.mockResolvedValueOnce(['near']);

      const before = Date.now();
      await orchestrator.offerToNextDriver(
        makeOrder({ distributorId: 'dist-1' }),
      );

      expect(settings.obtener).toHaveBeenCalledWith('dist-1');
      const expiresAt = (
        offers.create.mock.calls[0] as [string, string, Date]
      )[2];
      const ttlMs = expiresAt.getTime() - before;
      expect(ttlMs).toBeGreaterThanOrEqual(119_000);
      expect(ttlMs).toBeLessThanOrEqual(121_000);
      const [, payload] = dispatch.notifyDriverNewOrder.mock.calls[0] as [
        string,
        { expiresAt: string },
      ];
      expect(new Date(payload.expiresAt).getTime()).toBe(expiresAt.getTime());
    });

    it('CU-171: busca con los pasos de radio configurados, no con los de siempre', async () => {
      settings.obtener.mockResolvedValue({
        radiusStepsKm: [2, 7],
        offerTtlSeconds: 30,
      });

      await orchestrator.offerToNextDriver(makeOrder());

      expect(
        (
          dispatch.findNearbyDrivers.mock.calls as Array<
            [number, number, number]
          >
        ).map((c) => c[2]),
      ).toEqual([2, 7]);
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

    it('pide el aviso de la bandeja con el pedido y el día como clave, una vez por agotamiento', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-28T15:00:00Z'));
      try {
        await orchestrator.offerToNextDriver(
          makeOrder({ distributorId: 'dist-1' }),
        );
        expect(events.emit).toHaveBeenCalledWith(
          EVENTO_NOTIFICAR_ADMIN,
          expect.objectContaining({
            distributorId: 'dist-1',
            kind: 'order_no_drivers',
            dedupeKey: 'no-drivers:ord-1:2026-10-28',
            link: { entity: 'order', id: 'ord-1' },
            email: false,
          }),
        );

        events.emit.mockClear();
        redis.setIfAbsent.mockResolvedValue(false);
        await orchestrator.offerToNextDriver(
          makeOrder({ distributorId: 'dist-1' }),
        );
        expect(events.emit).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
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

    it('CU-173: sólo vence y re-ofrece las ofertas de las distribuidoras a las que les toca', async () => {
      offers.findExpired.mockResolvedValue([
        expiredOffer({ offerId: 'off-a', distributorId: 'dist-ok' }),
        expiredOffer({ offerId: 'off-b', distributorId: 'dist-espera' }),
      ]);
      orders.findByIdFull.mockResolvedValue(makeOrder());
      dispatch.findNearbyDrivers.mockResolvedValue(['d9']);

      await orchestrator.handleExpiredOffers(new Set(['dist-ok']));

      expect(offers.updateStatus).toHaveBeenCalledTimes(1);
      expect(offers.updateStatus).toHaveBeenCalledWith(
        'off-a',
        DispatchOfferStatus.EXPIRED,
      );
    });

    it('distribuidorasConOfertasVencidas: sin repetidos', async () => {
      offers.findExpired.mockResolvedValue([
        expiredOffer({ offerId: 'a', distributorId: 'd1' }),
        expiredOffer({ offerId: 'b', distributorId: 'd1' }),
        expiredOffer({ offerId: 'c', distributorId: 'd2' }),
      ]);
      expect(await orchestrator.distribuidorasConOfertasVencidas()).toEqual([
        'd1',
        'd2',
      ]);
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

    it('si la oferta ya no estaba OFFERED (la aceptaron entre la lectura y el cierre) no la vence ni re-ofrece el pedido', async () => {
      offers.findExpired.mockResolvedValue([expiredOffer()]);
      offers.updateStatus.mockResolvedValue(false);
      orders.findByIdFull.mockResolvedValue(makeOrder());
      dispatch.findNearbyDrivers.mockResolvedValue(['d2']);

      await orchestrator.handleExpiredOffers();

      expect(offers.updateStatus).toHaveBeenCalledWith(
        'off-1',
        DispatchOfferStatus.EXPIRED,
      );
      expect(orders.findByIdFull).not.toHaveBeenCalled();
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
