import { BadRequestException, ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import Decimal from 'decimal.js';
import { conRespuestaVigilada } from '../../common/interceptors/respuesta-incompleta';
import { CreateOrderUseCase } from './create-order.use-case';
import { OrderPricingService } from '../domain/order-pricing.service';
import { CreateOrderDto } from '../dto/create-order.dto';
import {
  OrderDeliveryMode,
  OrderStatus,
  PaymentMethod,
} from '../entities/order.entity';
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
  let customers: { buscarComprador: jest.Mock; reactivarVinculo: jest.Mock };
  let addresses: { buscarDelUsuario: jest.Mock };
  let orderItemRepository: { create: jest.Mock };
  let orderRepository: { create: jest.Mock };
  let paymentSurcharges: { porcentaje: jest.Mock };
  let pricing: { priceItem: jest.Mock; applyPaymentSurcharge: jest.Mock };
  let stock: { reservarStock: jest.Mock; leerBloqueada: jest.Mock };
  let dispatchOrchestrator: { offerToNextDriver: jest.Mock };
  let notificationService: { sendOrderConfirmation: jest.Mock };
  let orders: { findByIdFull: jest.Mock };
  let realtime: { notifyAdmins: jest.Mock };
  let paymentsService: { createCheckout: jest.Mock };
  let coverageZoneService: { checkCoverage: jest.Mock };
  let cart: { itemsParaPedido: jest.Mock; vaciarEnTransaccion: jest.Mock };
  let expressAvailability: { evaluar: jest.Mock };
  let customerAccount: { assertCredito: jest.Mock };

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
    cart = {
      itemsParaPedido: jest
        .fn()
        .mockResolvedValue([{ gasCylinderId: 'gc-1', quantity: 2 }]),
      vaciarEnTransaccion: jest.fn().mockResolvedValue(undefined),
    };

    customers = {
      buscarComprador: jest.fn().mockResolvedValue({
        email: 'cliente@test.com',
        fullName: 'Ana Pérez',
        phoneNumber: '+5491155551234',
      }),
      reactivarVinculo: jest.fn().mockResolvedValue(undefined),
    };
    addresses = {
      buscarDelUsuario: jest.fn().mockResolvedValue({
        addressId: 'addr-1',
        street: 'Av. Colón 1234',
        city: 'Posadas',
        postalCode: '3300',
        floor: '2',
        apartment: 'B',
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
      applyPaymentSurcharge: jest.fn((amount: Decimal, pct: number | Decimal) =>
        new OrderPricingService().applyPaymentSurcharge(amount, pct),
      ),
    };
    stock = {
      leerBloqueada: jest.fn().mockResolvedValue({
        gasCylinderId: 'gc-1',
        type: 'Garrafa 10kg',
        price: 1000,
        promotions: null,
        distributorId: 'dist-default',
      }),
      reservarStock: jest.fn().mockResolvedValue({
        gasCylinderId: 'gc-1',
        type: 'Garrafa 10kg',
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
    // Express disponible, con recargo de 1500, salvo que el test diga otra cosa.
    expressAvailability = {
      evaluar: jest.fn().mockResolvedValue({
        available: true,
        reason: null,
        message: null,
        settings: { surchargeAmount: 1500 },
      }),
    };

    customerAccount = { assertCredito: jest.fn().mockResolvedValue(undefined) };
    paymentSurcharges = {
      porcentaje: jest.fn((_d: unknown, medio: PaymentMethod) =>
        Promise.resolve(
          medio === PaymentMethod.MERCADOPAGO ||
            medio === PaymentMethod.TRANSFER
            ? 10
            : 0,
        ),
      ),
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
      coverageZonePricing,
      cart as unknown as import('../../cart/cart.service').CartService,
      expressAvailability as unknown as import('./express-availability.service').ExpressAvailabilityService,
      customerAccount as unknown as import('../domain/ports/customer-account.port').CustomerAccountPort,
      paymentSurcharges as unknown as import('../../distributor/payment-surcharge-settings.service').PaymentSurchargeSettingsService,
    );
  });

  describe('lo cotizado es lo cobrado (expectedTotal)', () => {
    it.each([
      [PaymentMethod.CASH, 2000],
      [PaymentMethod.TRANSFER, 2200],
      [PaymentMethod.MERCADOPAGO, 2200],
    ])('%s con el total vigente (%s): crea el pedido', async (medio, total) => {
      const result = await useCase.execute({
        ...baseDto,
        paymentMethod: medio,
        expectedTotal: total,
      });
      expect(result.order.orderId).toBe('ord-1');
      expect(queryRunner.manager.save).toHaveBeenCalled();
    });

    it('si el total cambió (el recargo ahora es otro) responde 409 y no crea nada', async () => {
      paymentSurcharges.porcentaje.mockResolvedValue(7.5);
      await expect(
        useCase.execute({
          ...baseDto,
          paymentMethod: PaymentMethod.TRANSFER,
          expectedTotal: 2200,
        }),
      ).rejects.toThrow(
        'Cambió el precio: revisá el total y confirmá de nuevo',
      );
      expect(queryRunner.manager.save).not.toHaveBeenCalled();
      expect(paymentsService.createCheckout).not.toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('un centavo de diferencia alcanza para el 409', async () => {
      await expect(
        useCase.execute({ ...baseDto, expectedTotal: 2000.01 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('sin expectedTotal el alta no compara nada', async () => {
      await expect(useCase.execute({ ...baseDto })).resolves.toBeDefined();
    });
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

  describe('checkout del carrito (fromCart, CU-126)', () => {
    const sinItems: CreateOrderDto = { ...baseDto, items: undefined };

    it('toma los ítems del carrito, cobra el precio del servidor y vacía el carrito en la misma transacción', async () => {
      await useCase.execute({ ...sinItems, fromCart: true }, 'dist-default');

      expect(cart.itemsParaPedido).toHaveBeenCalledWith(
        queryRunner.manager,
        'cust-1',
        'dist-default',
        true,
      );
      expect(stock.reservarStock).toHaveBeenCalledWith(
        queryRunner.manager,
        'gc-1',
        2,
      );
      expect(cart.vaciarEnTransaccion).toHaveBeenCalledWith(
        queryRunner.manager,
        'cust-1',
        'dist-default',
      );
      // El vaciado ocurre antes del commit.
      expect(cart.vaciarEnTransaccion.mock.invocationCallOrder[0]).toBeLessThan(
        queryRunner.commitTransaction.mock.invocationCallOrder[0],
      );
    });

    it('si el pedido falla, el carrito no se vacía', async () => {
      stock.reservarStock.mockRejectedValue(
        new BadRequestException('sin stock'),
      );

      await expect(
        useCase.execute({ ...sinItems, fromCart: true }, 'dist-default'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(cart.vaciarEnTransaccion).not.toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('carrito vacío o con productos caídos corta con el 400 del carrito', async () => {
      cart.itemsParaPedido.mockRejectedValue(
        new BadRequestException('Tu carrito está vacío'),
      );
      await expect(
        useCase.execute({ ...sinItems, fromCart: true }, 'dist-default'),
      ).rejects.toThrow('Tu carrito está vacío');
      expect(cart.vaciarEnTransaccion).not.toHaveBeenCalled();
    });

    it('con items y fromCart a la vez es 400 sin abrir la transacción', async () => {
      await expect(
        useCase.execute({ ...baseDto, fromCart: true }, 'dist-default'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('sin fromCart no toca el carrito', async () => {
      await useCase.execute(baseDto, 'dist-default');

      expect(cart.itemsParaPedido).not.toHaveBeenCalled();
      expect(cart.vaciarEnTransaccion).not.toHaveBeenCalled();
    });
  });

  describe('ACCOUNT (cuenta corriente)', () => {
    it('verifica el crédito con el total y dentro de la transacción del pedido', async () => {
      const result = await useCase.execute({
        ...baseDto,
        paymentMethod: PaymentMethod.ACCOUNT,
      });

      expect(customerAccount.assertCredito).toHaveBeenCalledWith(
        queryRunner.manager,
        'dist-default',
        'cust-1',
        expect.any(Decimal),
      );
      expect(result.order.orderId).toBe('ord-1');
      expect(paymentsService.createCheckout).not.toHaveBeenCalled();
      expect(dispatchOrchestrator.offerToNextDriver).toHaveBeenCalledTimes(1);
    });

    it('si el crédito no alcanza, no crea el pedido', async () => {
      customerAccount.assertCredito.mockRejectedValue(
        new ConflictException('supera el crédito disponible'),
      );
      await expect(
        useCase.execute({ ...baseDto, paymentMethod: PaymentMethod.ACCOUNT }),
      ).rejects.toThrow(ConflictException);
      expect(queryRunner.manager.save).not.toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it.each([
      ['una reserva', { isReservation: true, depositAmount: 100 }],
      ['un pedido agendado', {}],
    ])('%s con fecha pasada y sin franja es 400', async (_n, extra) => {
      await expect(
        useCase.execute({
          ...baseDto,
          ...extra,
          scheduledDate: '2020-01-01',
        }),
      ).rejects.toThrow('scheduledDate no puede ser una fecha pasada');
      expect(queryRunner.manager.save).not.toHaveBeenCalled();
    });

    it('una reserva por MercadoPago o transferencia guarda el recargo online aparte y el total cierra', async () => {
      pricing.applyPaymentSurcharge.mockImplementation((monto: Decimal) =>
        monto.times(1.1),
      );
      for (const medio of [PaymentMethod.MERCADOPAGO, PaymentMethod.TRANSFER]) {
        orderRepository.create.mockClear();
        await useCase.execute({
          ...baseDto,
          paymentMethod: medio,
          isReservation: true,
          depositAmount: 100,
          scheduledDate: '2099-01-01',
        });
        const llamadas = orderRepository.create.mock.calls as unknown as Record<
          string,
          number
        >[][];
        const orden = llamadas[0][0];
        expect(orden.paymentSurchargeAmount).toBe(200);
        expect(orden.totalAmount).toBe(
          orden.subtotalItems +
            orden.zoneSurchargeAmount +
            orden.paymentSurchargeAmount +
            orden.expressSurchargeAmount,
        );
      }
    });

    it('una reserva no se paga con cuenta corriente', async () => {
      await expect(
        useCase.execute({
          ...baseDto,
          paymentMethod: PaymentMethod.ACCOUNT,
          isReservation: true,
          scheduledDate: '2030-01-01',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(customerAccount.assertCredito).not.toHaveBeenCalled();
    });

    describe('tope de la seña (reserva)', () => {
      const reserva = (depositAmount: number): CreateOrderDto => ({
        ...baseDto,
        isReservation: true,
        scheduledDate: '2030-01-01',
        depositAmount,
      });

      it('una seña mayor al total se rechaza con 400 y no guarda nada', async () => {
        const intento = useCase.execute(reserva(2000.01));
        await expect(intento).rejects.toThrow(BadRequestException);
        await expect(intento).rejects.toThrow(
          'La seña ($2000.01) no puede superar el total del pedido ($2000.00)',
        );
        expect(queryRunner.manager.save).not.toHaveBeenCalled();
        expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      });

      it('una seña igual al total se acepta', async () => {
        const result = await useCase.execute(reserva(2000));
        expect(result.order.orderId).toBe('ord-1');
      });

      it('una seña menor al total se acepta', async () => {
        const result = await useCase.execute(reserva(500));
        expect(result.order.orderId).toBe('ord-1');
      });

      it.each([[undefined], [0]])(
        'una reserva con MercadoPago y seña %s es 400 y no guarda nada',
        async (depositAmount) => {
          const intento = useCase.execute({
            ...reserva(0),
            paymentMethod: PaymentMethod.MERCADOPAGO,
            depositAmount,
          });
          await expect(intento).rejects.toThrow(BadRequestException);
          await expect(intento).rejects.toThrow(
            'Una reserva con MercadoPago necesita una seña mayor a cero',
          );
          expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
          expect(paymentsService.createCheckout).not.toHaveBeenCalled();
        },
      );

      it('una reserva en efectivo con seña 0 u omitida se acepta', async () => {
        const result = await useCase.execute({
          ...reserva(0),
          paymentMethod: PaymentMethod.CASH,
        });
        expect(result.order.orderId).toBe('ord-1');
      });

      it('sin el indicador de reserva la seña no se mira', async () => {
        const result = await useCase.execute({
          ...baseDto,
          depositAmount: 999999,
        });
        expect(result.order.orderId).toBe('ord-1');
      });
    });

    it('con otro medio de pago no toca la cuenta', async () => {
      await useCase.execute({ ...baseDto, paymentMethod: PaymentMethod.CASH });
      expect(customerAccount.assertCredito).not.toHaveBeenCalled();
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

  describe('vínculo del cliente con la distribuidora', () => {
    it('un pedido nuevo reactiva el vínculo dado de baja, en la transacción del pedido', async () => {
      await useCase.execute(
        { ...baseDto, paymentMethod: PaymentMethod.CASH },
        'dist-default',
      );
      expect(customers.reactivarVinculo).toHaveBeenCalledWith(
        queryRunner.manager,
        'cust-1',
        'dist-default',
      );
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
        amount: 2200,
        isDeposit: false,
        items: [
          { id: 'gc-1', title: 'Garrafa 10kg', quantity: 2, unitPrice: 1000 },
          {
            id: 'online-surcharge',
            title: 'Recargo por pago online',
            quantity: 1,
            unitPrice: 200,
          },
        ],
        payer: {
          email: 'cliente@test.com',
          fullName: 'Ana Pérez',
          phone: '+5491155551234',
          address: { street: 'Av. Colón 1234', zipCode: '3300' },
        },
        receiverAddress: {
          street: 'Av. Colón 1234',
          city: 'Posadas',
          zipCode: '3300',
          floor: '2',
          apartment: 'B',
        },
      });
      expect(result.paymentUrl).toBe('https://mp.test/checkout');
    });

    it.each([
      [0, 2000, 0],
      [7.5, 2150, 150],
      [30, 2600, 600],
    ])(
      'con el recargo de la distribuidora en %s %%: cobra %s y guarda el %% en el pedido',
      async (porcentaje, cobrado, recargo) => {
        paymentSurcharges.porcentaje.mockResolvedValue(porcentaje);

        await useCase.execute({
          ...baseDto,
          paymentMethod: PaymentMethod.MERCADOPAGO,
        });

        expect(paymentSurcharges.porcentaje).toHaveBeenCalledWith(
          'dist-default',
          PaymentMethod.MERCADOPAGO,
        );
        const llamada = paymentsService.createCheckout.mock.calls[0] as [
          { amount: number; items: { id: string; unitPrice: number }[] },
        ];
        expect(llamada[0].amount).toBe(cobrado);
        expect(
          llamada[0].items.find((i) => i.id === 'online-surcharge')?.unitPrice,
        ).toBe(recargo === 0 ? undefined : recargo);
        const orden = (
          orderRepository.create.mock.calls as unknown as Record<
            string,
            unknown
          >[][]
        )[0][0];
        expect(orden.paymentSurchargePercentage).toBe(porcentaje);
        expect(orden.paymentSurchargeAmount).toBe(recargo);
        expect(orden.totalAmount).toBe(cobrado);
      },
    );

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

  describe('modalidad express (CU-147, CU-148)', () => {
    const express: CreateOrderDto = {
      ...baseDto,
      deliveryMode: OrderDeliveryMode.EXPRESS,
    };

    function ordenCreada(): Record<string, unknown> {
      const llamadas = orderRepository.create.mock.calls as unknown as Record<
        string,
        unknown
      >[][];
      return llamadas[0][0];
    }

    it('guarda la modalidad y el recargo, y lo suma al final del total', async () => {
      await useCase.execute(express);

      const orden = ordenCreada();
      expect(orden.deliveryMode).toBe(OrderDeliveryMode.EXPRESS);
      expect(orden.expressSurchargeAmount).toBe(1500);
      expect(orden.subtotalItems).toBe(2000);
      expect(orden.totalAmount).toBe(3500);
      expect(dispatchOrchestrator.offerToNextDriver).toHaveBeenCalledTimes(1);
    });

    it('un pedido común no evalúa el express ni lleva recargo', async () => {
      await useCase.execute({ ...baseDto });

      expect(expressAvailability.evaluar).not.toHaveBeenCalled();
      const orden = ordenCreada();
      expect(orden.deliveryMode).toBe(OrderDeliveryMode.STANDARD);
      expect(orden.expressSurchargeAmount).toBe(0);
      expect(orden.totalAmount).toBe(2000);
    });

    it('el recargo express no lleva el recargo por medio de pago', async () => {
      pricing.applyPaymentSurcharge.mockImplementation((monto: Decimal) =>
        monto.times(1.1),
      );

      await useCase.execute({
        ...express,
        paymentMethod: PaymentMethod.MERCADOPAGO,
      });

      // 2000 × 1.1 + 1500 (y no (2000 + 1500) × 1.1)
      expect(ordenCreada().totalAmount).toBe(3700);
    });

    it('guarda el recargo por medio de pago aparte y el total es la suma exacta de sus partes', async () => {
      pricing.applyPaymentSurcharge.mockImplementation((monto: Decimal) =>
        monto.times(1.1),
      );

      await useCase.execute({
        ...express,
        paymentMethod: PaymentMethod.MERCADOPAGO,
      });

      const orden = ordenCreada();
      expect(orden.paymentSurchargeAmount).toBe(200);
      expect(orden.totalAmount).toBe(
        Number(orden.subtotalItems) +
          Number(orden.zoneSurchargeAmount) +
          Number(orden.paymentSurchargeAmount) +
          Number(orden.expressSurchargeAmount),
      );
    });

    it('un pedido en efectivo no lleva recargo por medio de pago', async () => {
      await useCase.execute({ ...baseDto });

      expect(ordenCreada().paymentSurchargeAmount).toBe(0);
    });

    it('el recargo por medio de pago se redondea a 2 decimales y el total sigue cerrando', () => {
      pricing.applyPaymentSurcharge.mockImplementation((monto: Decimal) =>
        monto.times(1.1),
      );

      const { totalAmount, paymentSurchargeAmount } = useCase.calcularTotales(
        new Decimal('1000.05'),
        null,
        10,
      );

      // 1000,05 × 1,1 = 1100,055 → 1100,06
      expect(paymentSurchargeAmount.toString()).toBe('100.01');
      expect(totalAmount.toString()).toBe('1100.06');
    });

    it('con MercadoPago el checkout cobra el recargo como un renglón más', async () => {
      await useCase.execute({
        ...express,
        paymentMethod: PaymentMethod.MERCADOPAGO,
      });

      expect(paymentsService.createCheckout).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [
            expect.objectContaining({ id: 'gc-1' }),
            expect.objectContaining({ id: 'online-surcharge' }),
            {
              id: 'express-surcharge',
              title: 'Recargo express',
              quantity: 1,
              unitPrice: 1500,
            },
          ],
        }),
      );
      expect(dispatchOrchestrator.offerToNextDriver).not.toHaveBeenCalled();
    });

    it.each([
      'disabled',
      'out_of_coverage',
      'out_of_hours',
      'no_motorcycle_driver',
    ])(
      'si no está disponible (%s) responde 409 con el motivo y no reserva stock',
      async (reason) => {
        expressAvailability.evaluar.mockResolvedValue({
          available: false,
          reason,
          message: 'no',
          settings: { surchargeAmount: 1500 },
        });

        const error = await useCase.execute(express).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'EXPRESS_NOT_AVAILABLE',
          reason,
        });
        expect(stock.reservarStock).not.toHaveBeenCalled();
        expect(queryRunner.manager.save).not.toHaveBeenCalled();
        expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      },
    );

    it.each([
      { isReservation: true, scheduledDate: '2026-12-01' },
      { timeSlotId: '3f1c3c1e-0f0f-4f0f-8f0f-0f0f0f0f0f0f' },
      { scheduledDate: '2026-12-01' },
    ])('no se combina con lo agendado (%o): 400', async (agenda) => {
      await expect(useCase.execute({ ...express, ...agenda })).rejects.toThrow(
        /no se agenda/,
      );
      expect(expressAvailability.evaluar).not.toHaveBeenCalled();
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
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
