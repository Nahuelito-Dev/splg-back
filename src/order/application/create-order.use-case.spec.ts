import Decimal from 'decimal.js';
import { CreateOrderUseCase } from './create-order.use-case';
import { CreateOrderDto } from '../dto/create-order.dto';
import { OrderStatus, PaymentMethod } from '../entities/order.entity';

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
    manager: { save: jest.Mock };
  };
  let customers: { buscarComprador: jest.Mock };
  let addresses: { buscarDelUsuario: jest.Mock };
  let orderItemRepository: { create: jest.Mock };
  let orderRepository: { create: jest.Mock };
  let pricing: { priceItem: jest.Mock; applyPaymentSurcharge: jest.Mock };
  let stock: { reservarStock: jest.Mock };
  let dispatchOrchestrator: { offerToNextDriver: jest.Mock };
  let notificationService: { sendOrderConfirmation: jest.Mock };
  let orders: { findByIdFull: jest.Mock };
  let realtime: { notifyAdmins: jest.Mock };
  let paymentsService: { createCheckout: jest.Mock };

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
        save: jest.fn((o: Record<string, unknown>) =>
          Promise.resolve({ ...o, order_id: 'ord-1' }),
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
        address_id: 'addr-1',
        latitude: '-34.6',
        longitude: '-58.4',
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
      reservarStock: jest.fn().mockResolvedValue({
        gas_cylinder_id: 'gc-1',
        type: '10kg',
        price: 1000,
        promotions: null,
        // Debe pertenecer a la distribuidora del pedido (default en estos tests).
        distributor_id: 'dist-default',
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
        order_id: 'ord-1',
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
        .mockResolvedValue({ distributor_id: 'dist-default' }),
    };
    // Agendamiento: sin scheduledDate no se invoca; mock por si algún test lo usa.
    // `assertSlotAvailableTx` es la versión transaccional con lock (la que usa el
    // use-case cuando el pedido trae fecha + franja).
    const timeSlotService = {
      assertSlotAvailable: jest.fn().mockResolvedValue(undefined),
      assertSlotAvailableTx: jest.fn().mockResolvedValue(undefined),
    };

    // Sin zonas definidas → cubierto, sin recargo (no-op), por defecto.
    const coverageZoneService = {
      checkCoverage: jest
        .fn()
        .mockResolvedValue({ covered: true, surcharge: 0 }),
    };

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
      expect(result.order.order_id).toBe('ord-1');
      expect(realtime.notifyAdmins).toHaveBeenCalledWith(
        'order:created',
        expect.any(Object),
      );
    });
  });

  describe('aislamiento multi-tenant', () => {
    it('rechaza una garrafa de OTRA distribuidora', async () => {
      stock.reservarStock.mockResolvedValueOnce({
        gas_cylinder_id: 'gc-x',
        type: '10kg',
        price: 1000,
        promotions: null,
        distributor_id: 'dist-OTRO',
      });
      await expect(useCase.execute({ ...baseDto })).rejects.toThrow(
        /no pertenece a la distribuidora/,
      );
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('rechaza una garrafa con distributor_id null (sin tenant)', async () => {
      stock.reservarStock.mockResolvedValueOnce({
        gas_cylinder_id: 'gc-null',
        type: '10kg',
        price: 1000,
        promotions: null,
        distributor_id: null,
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

      expect(result.order.order_id).toBe('ord-1');
      expect(result.paymentUrl).toBeUndefined();
      expect(dispatchOrchestrator.offerToNextDriver).not.toHaveBeenCalled();
    });
  });
});
