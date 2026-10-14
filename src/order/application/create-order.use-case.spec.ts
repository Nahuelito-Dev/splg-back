import { EntityManager } from 'typeorm';
import Decimal from 'decimal.js';
import { conRespuestaVigilada } from '../../common/interceptors/respuesta-incompleta';
import { CreateOrderUseCase } from './create-order.use-case';
import { CreateOrderDto } from '../dto/create-order.dto';
import { OrderStatus, PaymentMethod } from '../entities/order.entity';
import { CoverageZonePricingService } from '../../coverage-zone/coverage-zone-pricing.service';
import { CoverageZoneSurchargeType } from '../../coverage-zone/entities/coverage-zone.entity';

/**
 * Use-case de creación de pedido. Foco de estos tests: el BRANCH por método
 * de pago (MERCADOPAGO no despacha y crea checkout; CASH/TRANSFER despachan
 * como siempre). El resto (reserva de stock, pricing) lo cubren
 * stock-reservation.service.spec y order-pricing.service.spec.
 */
describe('CreateOrderUseCase', () => {
  let useCase: CreateOrderUseCase;

  let dataSource: { createQueryRunner: jest.Mock };
  let queryRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    isTransactionActive: boolean;
    manager: { save: jest.Mock; query: jest.Mock };
  };
  let customers: { buscarComprador: jest.Mock };
  let addresses: { buscarDelUsuario: jest.Mock };
  let orderItemRepository: { create: jest.Mock };
  let orderRepository: { create: jest.Mock };
  let pricing: { priceItem: jest.Mock; applyPaymentSurcharge: jest.Mock };
  let stock: { reservarStock: jest.Mock; leerBloqueada: jest.Mock };
  let dispatchOrchestrator: { offerToNextDriver: jest.Mock };
  let notificationService: { sendOrderConfirmation: jest.Mock };
  let orders: { findByIdFull: jest.Mock };
  let realtime: { notifyAdmins: jest.Mock };
  let paymentsService: { createCheckout: jest.Mock };
  let coverageZoneService: { checkCoverage: jest.Mock };

  const baseDto: CreateOrderDto = {
    customerId: 'cust-1',
    addressId: 'addr-1',
    items: [{ gasCylinderId: 'gc-1', quantity: 2, unitPrice: 1000 }],
    paymentMethod: PaymentMethod.CASH,
  };

  beforeEach(() => {
    queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      isTransactionActive: true,
      manager: {
        query: jest.fn().mockResolvedValue([{ deleted: false }]),
        save: jest.fn((o: Record<string, unknown>) =>
          Promise.resolve({ ...o, orderId: 'ord-1' }),
        ),
      },
    };
    dataSource = { createQueryRunner: jest.fn(() => queryRunner) };

    customers = {
      buscarComprador: jest.fn().mockResolvedValue({
        email: 'cliente@test.com',
      }),
    };
    addresses = {
      buscarDelUsuario: jest.fn().mockResolvedValue({
        addressId: 'addr-1',
        latitude: '-34.6',
        longitude: '-58.4',
        // GeoJSON Point (lng, lat): lo que lee `coordenadasDePunto` para el
        // chequeo de cobertura. Sin esto, `punto` da null y checkCoverage NUNCA
        // se llama (quedaba sin probar).
        location: { type: 'Point', coordinates: [-58.4, -34.6] },
      }),
    };
    orderItemRepository = { create: jest.fn((data: unknown) => data) };
    orderRepository = { create: jest.fn((data: unknown) => data) };
    pricing = {
      priceItem: jest.fn(() => ({
        unitPrice: new Decimal(1000),
        subtotal: new Decimal(2000),
      })),
      applyPaymentSurcharge: jest.fn((amount: unknown) => amount),
    };
    stock = {
      leerBloqueada: jest.fn().mockResolvedValue({
        gasCylinderId: 'gc-1',
        type: '10kg',
        price: 1000,
        promotions: null,
        distributorId: 'dist-default',
      }),
      reservarStock: jest.fn().mockResolvedValue({
        gasCylinderId: 'gc-1',
        type: '10kg',
        price: 1000,
        promotions: null,
        // Debe pertenecer a la distribuidora del pedido (default en estos tests).
        distributorId: 'dist-default',
      }),
    };
    dispatchOrchestrator = {
      offerToNextDriver: jest.fn().mockResolvedValue('drv-1'),
    };
    notificationService = {
      sendOrderConfirmation: jest.fn().mockResolvedValue(undefined),
    };
    orders = {
      findByIdFull: jest.fn().mockResolvedValue({
        orderId: 'ord-1',
        status: OrderStatus.PENDING,
      }),
    };
    realtime = { notifyAdmins: jest.fn() };
    paymentsService = {
      createCheckout: jest.fn().mockResolvedValue({
        initPoint: 'https://mp.test/checkout',
        preferenceId: 'pref-1',
      }),
    };
    // Multi-tenant: sin tenant explícito, el use-case pide la distribuidora
    // default. Devolvemos una fija para los tests.
    const distributorService = {
      getDefault: jest
        .fn()
        .mockResolvedValue({ distributorId: 'dist-default' }),
    };
    // Agendamiento: sin scheduledDate no se invoca; mock por si algún test lo usa.
    // `assertSlotAvailableTx` es la versión transaccional con lock (la que usa el
    // use-case cuando el pedido trae fecha + franja).
    const timeSlotService = {
      assertSlotAvailable: jest.fn().mockResolvedValue(undefined),
      assertSlotAvailableTx: jest.fn().mockResolvedValue(undefined),
    };

    // Sin zonas definidas → cubierto, sin zona (no-op), por defecto.
    coverageZoneService = {
      checkCoverage: jest
        .fn()
        .mockResolvedValue({ covered: true, surcharge: 0, zone: null }),
    };
    const coverageZonePricing = new CoverageZonePricingService();

    useCase = new CreateOrderUseCase(
      dataSource as unknown as import('typeorm').DataSource,
      customers as unknown as import('../../customer/customer.service').CustomersService,
      addresses as unknown as import('../../user-address/user-address.service').UserAddressService,
      orderItemRepository as unknown as import('typeorm').Repository<
        import('../entities/order-item.entity').OrderItem
      >,
      orderRepository as unknown as import('typeorm').Repository<
        import('../entities/order.entity').Order
      >,
      pricing as unknown as import('../domain/order-pricing.service').OrderPricingService,
      stock as unknown as import('../../gascylinder/gascylinder.service').GasCylinderService,
      dispatchOrchestrator as unknown as import('./dispatch-orchestrator.service').DispatchOrchestratorService,
      notificationService as unknown as import('../domain/ports/notification.port').NotificationPort,
      orders as unknown as import('../domain/ports/order.repository.port').OrderRepositoryPort,
      realtime as unknown as import('../domain/ports/realtime-dispatch.port').RealtimeDispatchPort,
      paymentsService as unknown as import('../../payments/application/payments.service').PaymentsService,
      distributorService as unknown as import('../../distributor/distributor.service').DistributorService,
      timeSlotService as unknown as import('../../time-slot/time-slot.service').TimeSlotService,
      coverageZoneService as unknown as import('../../coverage-zone/coverage-zone.service').CoverageZoneService,
      coverageZonePricing,
    );
  });

  describe('CASH', () => {
    it('despacha al chofer más cercano y NO crea checkout', async () => {
      const result = await useCase.execute({
        ...baseDto,
        paymentMethod: PaymentMethod.CASH,
      });

      expect(dispatchOrchestrator.offerToNextDriver).toHaveBeenCalledTimes(1);
      expect(paymentsService.createCheckout).not.toHaveBeenCalled();
      expect(result.paymentUrl).toBeUndefined();
      expect(result.order.orderId).toBe('ord-1');
      expect(realtime.notifyAdmins).toHaveBeenCalledWith(
        'order:created',
        expect.any(Object),
        expect.any(String),
      );
    });
  });

  describe('falla después del commit', () => {
    it('si la relectura falla, el pedido confirmado se devuelve igual (un reintento no lo duplica)', async () => {
      orders.findByIdFull.mockRejectedValue(new Error('conexión caída'));
      const { valor: result, incompleta } = await conRespuestaVigilada(() =>
        useCase.execute({ ...baseDto, paymentMethod: PaymentMethod.CASH }),
      );
      expect(result.order.orderId).toBeDefined();
      // La idempotencia no la guarda 24 h como si fuera completa.
      expect(incompleta).toBe(true);
    });

    it('si falla el aviso al panel, el pedido confirmado se devuelve igual', async () => {
      realtime.notifyAdmins.mockImplementation(() => {
        throw new Error('socket caído');
      });
      const result = await useCase.execute({
        ...baseDto,
        paymentMethod: PaymentMethod.CASH,
      });
      expect(result.order.orderId).toBe('ord-1');
    });

    it('si la relectura no encuentra el pedido, devuelve el guardado', async () => {
      orders.findByIdFull.mockResolvedValue(null);
      const result = await useCase.execute({
        ...baseDto,
        paymentMethod: PaymentMethod.CASH,
      });
      expect(result.order.orderId).toBeDefined();
    });
  });

  describe('cuenta del cliente (carrera con la baja)', () => {
    it('toma el lock de la cuenta (FOR SHARE) antes que el stock y la franja', async () => {
      await useCase.execute({ ...baseDto, paymentMethod: PaymentMethod.CASH });
      const [sql, params] = queryRunner.manager.query.mock.calls[0] as [
        string,
        string[],
      ];
      expect(sql).toContain('FROM "user"');
      expect(sql).toContain('FOR SHARE');
      expect(params).toEqual(['cust-1']);
      expect(
        queryRunner.manager.query.mock.invocationCallOrder[0],
      ).toBeLessThan(stock.reservarStock.mock.invocationCallOrder[0]);
    });

    it('si la baja ganó la carrera es 404, no reserva stock y no guarda', async () => {
      queryRunner.manager.query.mockResolvedValueOnce([{ deleted: true }]);
      await expect(
        useCase.execute({ ...baseDto, paymentMethod: PaymentMethod.CASH }),
      ).rejects.toThrow('Cliente no encontrado');
      expect(stock.reservarStock).not.toHaveBeenCalled();
      expect(queryRunner.manager.save).not.toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    });
  });

  describe('reservarRenglones con la reserva ya ajustada (edición)', () => {
    it('sólo bloquea y lee el precio: no vuelve a descontar el stock', async () => {
      const manager = queryRunner.manager as unknown as EntityManager;
      const r = await useCase.reservarRenglones(
        manager,
        [{ gasCylinderId: 'gc-1', quantity: 2 }],
        'dist-default',
        true,
      );
      expect(stock.leerBloqueada).toHaveBeenCalledWith(manager, 'gc-1');
      expect(stock.reservarStock).not.toHaveBeenCalled();
      expect(r.orderItems).toHaveLength(1);
    });
  });

  describe('aislamiento multi-tenant', () => {
    it('rechaza una garrafa de OTRA distribuidora', async () => {
      stock.reservarStock.mockResolvedValueOnce({
        gasCylinderId: 'gc-x',
        type: '10kg',
        price: 1000,
        promotions: null,
        distributorId: 'dist-OTRO',
      });
      await expect(useCase.execute({ ...baseDto })).rejects.toThrow(
        /no pertenece a la distribuidora/,
      );
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('rechaza una garrafa con distributor_id null (sin tenant)', async () => {
      stock.reservarStock.mockResolvedValueOnce({
        gasCylinderId: 'gc-null',
        type: '10kg',
        price: 1000,
        promotions: null,
        distributorId: null,
      });
      await expect(useCase.execute({ ...baseDto })).rejects.toThrow(
        /no pertenece a la distribuidora/,
      );
    });
  });

  describe('MERCADOPAGO', () => {
    it('NO despacha, crea el checkout y devuelve paymentUrl', async () => {
      const result = await useCase.execute({
        ...baseDto,
        paymentMethod: PaymentMethod.MERCADOPAGO,
      });

      expect(dispatchOrchestrator.offerToNextDriver).not.toHaveBeenCalled();
      expect(paymentsService.createCheckout).toHaveBeenCalledWith({
        orderId: 'ord-1',
        distributorId: 'dist-default',
        amount: 2000,
        isDeposit: false,
        items: [
          { id: 'gc-1', title: 'Garrafa 10kg', quantity: 2, unitPrice: 1000 },
        ],
        payerEmail: 'cliente@test.com',
      });
      expect(result.paymentUrl).toBe('https://mp.test/checkout');
    });

    it('si la pasarela falla, el pedido queda creado igual sin paymentUrl (best-effort)', async () => {
      paymentsService.createCheckout.mockRejectedValue(new Error('MP caído'));

      const result = await useCase.execute({
        ...baseDto,
        paymentMethod: PaymentMethod.MERCADOPAGO,
      });

      expect(result.order.orderId).toBe('ord-1');
      expect(result.paymentUrl).toBeUndefined();
      expect(dispatchOrchestrator.offerToNextDriver).not.toHaveBeenCalled();
    });
  });

  describe('zona de cobertura', () => {
    /**
     * `orderRepository.create` refleja exactamente lo que arma el use-case
     * (el mock lo devuelve tal cual); `orders.findByIdFull` está mockeado
     * aparte y no sirve para esto, así que el snapshot se verifica sobre lo
     * que se le pasó a `create`.
     */
    function ordenCreada(): Record<string, unknown> {
      const llamadas = orderRepository.create.mock.calls as unknown as Record<
        string,
        unknown
      >[][];
      return llamadas[0][0];
    }

    it('sin zona (no-op): snapshot en null y recargo 0', async () => {
      await useCase.execute({ ...baseDto });
      const orden = ordenCreada();
      expect(orden.coverageZoneId).toBeNull();
      expect(orden.zoneName).toBeNull();
      expect(orden.zoneSurchargeType).toBeNull();
      expect(orden.zoneSurchargeValue).toBeNull();
      expect(orden.zoneSurchargeAmount).toBe(0);
      expect(orden.subtotalItems).toBe(2000); // 2 × 1000 (mock de pricing)
      expect(orden.totalAmount).toBe(2000);
    });

    it('fixed: suma el monto tal cual y lo deja en el snapshot', async () => {
      coverageZoneService.checkCoverage.mockResolvedValue({
        covered: true,
        zoneId: 'z1',
        zoneName: 'Posadas',
        surcharge: 500,
        zone: {
          id: 'z1',
          name: 'Posadas',
          type: CoverageZoneSurchargeType.FIXED,
          value: 500,
          color: null,
        },
      });

      await useCase.execute({ ...baseDto });
      const orden = ordenCreada();
      expect(orden.coverageZoneId).toBe('z1');
      expect(orden.zoneName).toBe('Posadas');
      expect(orden.zoneSurchargeType).toBe(CoverageZoneSurchargeType.FIXED);
      expect(orden.zoneSurchargeValue).toBe(500);
      expect(orden.zoneSurchargeAmount).toBe(500);
      expect(orden.subtotalItems).toBe(2000);
      expect(orden.totalAmount).toBe(2500); // 2000 + 500, sin recargo online
    });

    it('percentage: calcula el recargo sobre el subtotal de los ítems', async () => {
      coverageZoneService.checkCoverage.mockResolvedValue({
        covered: true,
        zoneId: 'z2',
        zoneName: 'Villa Lanús',
        surcharge: 10,
        zone: {
          id: 'z2',
          name: 'Villa Lanús',
          type: CoverageZoneSurchargeType.PERCENTAGE,
          value: 10,
          color: '#FF7A00',
        },
      });

      await useCase.execute({ ...baseDto });
      const orden = ordenCreada();
      expect(orden.zoneSurchargeType).toBe(
        CoverageZoneSurchargeType.PERCENTAGE,
      );
      expect(orden.zoneSurchargeValue).toBe(10);
      expect(orden.zoneSurchargeAmount).toBe(200); // 10% de 2000
      expect(orden.totalAmount).toBe(2200);
    });

    it('el recargo de zona se aplica ANTES del recargo por pago online', async () => {
      pricing.applyPaymentSurcharge.mockImplementation((amount: Decimal) =>
        amount.times(1.1),
      );
      coverageZoneService.checkCoverage.mockResolvedValue({
        covered: true,
        zoneId: 'z1',
        zoneName: 'Posadas',
        surcharge: 500,
        zone: {
          id: 'z1',
          name: 'Posadas',
          type: CoverageZoneSurchargeType.FIXED,
          value: 500,
          color: null,
        },
      });

      await useCase.execute({
        ...baseDto,
        paymentMethod: PaymentMethod.MERCADOPAGO,
      });
      const orden = ordenCreada();
      // (2000 + 500) × 1.1 = 2750
      expect(orden.totalAmount).toBe(2750);
      expect(orden.subtotalItems).toBe(2000);
      expect(orden.zoneSurchargeAmount).toBe(500);
    });

    it('rechaza el pedido si la dirección está fuera de cobertura', async () => {
      coverageZoneService.checkCoverage.mockResolvedValue({
        covered: false,
        surcharge: 0,
        zone: null,
      });
      await expect(useCase.execute({ ...baseDto })).rejects.toThrow(
        /fuera de la zona de cobertura/,
      );
    });
  });
});
