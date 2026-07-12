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

  let dataSource: any;
  let queryRunner: any;
  let userRepository: { findOne: jest.Mock };
  let userAddressRepository: { findOne: jest.Mock };
  let orderItemRepository: { create: jest.Mock };
  let orderRepository: { create: jest.Mock };
  let pricing: { priceItem: jest.Mock; applyPaymentSurcharge: jest.Mock };
  let stock: { reserve: jest.Mock };
  let dispatchOrchestrator: { offerToNextDriver: jest.Mock };
  let notificationService: { sendOrderConfirmation: jest.Mock };
  let orders: { findByIdFull: jest.Mock };
  let realtime: { notifyAdmins: jest.Mock };
  let paymentGateway: { createCheckout: jest.Mock };

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
        save: jest.fn(async (o: any) => ({ ...o, order_id: 'ord-1' })),
      },
    };
    dataSource = { createQueryRunner: jest.fn(() => queryRunner) };

    userRepository = {
      findOne: jest.fn().mockResolvedValue({
        user_id: 'cust-1',
        email: 'cliente@test.com',
        customer: { customer_id: 'c-1' },
      }),
    };
    userAddressRepository = {
      findOne: jest.fn().mockResolvedValue({
        address_id: 'addr-1',
        latitude: '-34.6',
        longitude: '-58.4',
      }),
    };
    orderItemRepository = { create: jest.fn((data) => data) };
    orderRepository = { create: jest.fn((data) => data) };
    pricing = {
      priceItem: jest.fn(() => ({
        unitPrice: new Decimal(1000),
        subtotal: new Decimal(2000),
      })),
      applyPaymentSurcharge: jest.fn((amount) => amount),
    };
    stock = {
      reserve: jest.fn().mockResolvedValue({
        gas_cylinder_id: 'gc-1',
        type: '10kg',
        price: 1000,
        promotions: null,
      }),
    };
    dispatchOrchestrator = { offerToNextDriver: jest.fn().mockResolvedValue('drv-1') };
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
    paymentGateway = {
      createCheckout: jest.fn().mockResolvedValue({
        initPoint: 'https://mp.test/checkout',
        preferenceId: 'pref-1',
      }),
    };
    // Multi-tenant: sin tenant explícito, el use-case pide la distribuidora
    // default. Devolvemos una fija para los tests.
    const distributorService = {
      getDefault: jest.fn().mockResolvedValue({ distributor_id: 'dist-default' }),
    };
    // Agendamiento: sin scheduledDate no se invoca; mock por si algún test lo usa.
    const timeSlotService = {
      assertSlotAvailable: jest.fn().mockResolvedValue(undefined),
    };

    useCase = new CreateOrderUseCase(
      dataSource as any,
      userRepository as any,
      userAddressRepository as any,
      orderItemRepository as any,
      orderRepository as any,
      pricing as any,
      stock as any,
      dispatchOrchestrator as any,
      notificationService as any,
      orders as any,
      realtime as any,
      paymentGateway as any,
      distributorService as any,
      timeSlotService as any,
    );
  });

  describe('CASH', () => {
    it('despacha al chofer más cercano y NO crea checkout', async () => {
      const result = await useCase.execute({
        ...baseDto,
        paymentMethod: PaymentMethod.CASH,
      });

      expect(dispatchOrchestrator.offerToNextDriver).toHaveBeenCalledTimes(1);
      expect(paymentGateway.createCheckout).not.toHaveBeenCalled();
      expect(result.paymentUrl).toBeUndefined();
      expect(result.order.order_id).toBe('ord-1');
      expect(realtime.notifyAdmins).toHaveBeenCalledWith(
        'order:created',
        expect.any(Object),
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
      expect(paymentGateway.createCheckout).toHaveBeenCalledWith({
        orderId: 'ord-1',
        items: [
          { id: 'gc-1', title: 'Garrafa 10kg', quantity: 2, unitPrice: 1000 },
        ],
        payerEmail: 'cliente@test.com',
      });
      expect(result.paymentUrl).toBe('https://mp.test/checkout');
    });

    it('si la pasarela falla, el pedido queda creado igual sin paymentUrl (best-effort)', async () => {
      paymentGateway.createCheckout.mockRejectedValue(new Error('MP caído'));

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
