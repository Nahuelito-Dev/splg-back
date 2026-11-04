import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { RoleType } from '../../common/constants/role-type.enum';
import { CoverageZonePricingService } from '../../coverage-zone/coverage-zone-pricing.service';
import { CoverageZoneSurchargeType } from '../../coverage-zone/entities/coverage-zone.entity';
import type { GasCylinder } from '../../gascylinder/entities/gascylinder.entity';
import { InsufficientStockError } from '../../gascylinder/domain/errors/insufficient-stock.error';
import {
  OrderDeliveryMode,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../entities/order.entity';
import { ConflictException } from '@nestjs/common';
import { PaymentSurchargeSettingsService } from '../../distributor/payment-surcharge-settings.service';
import type { ModuleConfigService } from '../../distributor/module-config.service';
import { OrderPricingService } from '../domain/order-pricing.service';
import { CreateOrderUseCase } from './create-order.use-case';
import { QuoteOrderUseCase } from './quote-order.use-case';

const DIST = 'dist-1';
const CLIENTE = { userId: 'cli-1', role: RoleType.CUSTOMER };
const ADMIN = { userId: 'adm-1', role: RoleType.ADMIN };
const G10 = 'garrafa-10';
const G15 = 'garrafa-15';

describe('QuoteOrderUseCase', () => {
  let zona: {
    id: string;
    name: string;
    type: CoverageZoneSurchargeType;
    value: number;
  } | null;
  let stock: { leerParaCotizar: jest.Mock };
  let addresses: { buscarDelUsuario: jest.Mock };
  let distributors: { getDefault: jest.Mock };
  let timeSlots: {
    assertSlotUsableTx: jest.Mock;
    assertSlotAvailable: jest.Mock;
  };
  let expressAvailability: { evaluar: jest.Mock };
  let casoDeUso: QuoteOrderUseCase;
  let parametrosDeRecargo: Record<string, number> | null;
  let manager: { findOne: jest.Mock; find: jest.Mock };
  let cart: { itemsParaPedido: jest.Mock };

  const garrafa = (over: Partial<GasCylinder>): GasCylinder =>
    ({
      type: '10kg',
      price: 10000,
      stock: 50,
      distributorId: DIST,
      promotions: [],
      ...over,
    }) as unknown as GasCylinder;

  beforeEach(() => {
    zona = null;
    parametrosDeRecargo = null;
    cart = {
      itemsParaPedido: jest
        .fn()
        .mockResolvedValue([{ gasCylinderId: G10, quantity: 2 }]),
    };
    manager = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };
    const catalogo: Record<string, GasCylinder> = {
      [G10]: garrafa({ price: 10000 }),
      // 3 o más: 10% de descuento por volumen.
      [G15]: garrafa({
        type: '15kg',
        price: 15000,
        promotions: [{ quantity: 3, discountPercentage: 10 }] as never,
      }),
    };
    stock = {
      leerParaCotizar: jest.fn((id: string) => Promise.resolve(catalogo[id])),
    };
    addresses = {
      buscarDelUsuario: jest.fn().mockResolvedValue({ location: null }),
    };
    timeSlots = {
      assertSlotUsableTx: jest.fn().mockResolvedValue(undefined),
      assertSlotAvailable: jest.fn().mockResolvedValue(undefined),
    };
    distributors = {
      getDefault: jest.fn().mockResolvedValue({ distributorId: DIST }),
    };
    // El caso de uso del alta de verdad: la cotización reusa sus reglas.
    expressAvailability = {
      evaluar: jest.fn().mockResolvedValue({
        available: true,
        reason: null,
        message: null,
        settings: { surchargeAmount: 1500 },
      }),
    };
    const alta = Object.assign(Object.create(CreateOrderUseCase.prototype), {
      expressAvailability,
      pricing: new OrderPricingService(),
      paymentSurcharges: new PaymentSurchargeSettingsService({
        parametros: () => Promise.resolve(parametrosDeRecargo),
      } as unknown as ModuleConfigService),
      coverageZonePricing: new CoverageZonePricingService(),
      orderItemRepository: { create: (x: unknown) => x },
      coverageZoneService: { checkCoverage: jest.fn() },
    }) as CreateOrderUseCase;
    jest
      .spyOn(alta, 'resolverZona')
      .mockImplementation(() => Promise.resolve(zona as never));
    casoDeUso = new QuoteOrderUseCase(
      alta,
      stock as never,
      addresses as never,
      distributors as never,
      timeSlots as never,
      { manager } as never,
      cart as never,
    );
  });

  const items = [
    { gasCylinderId: G10, quantity: 2, unitPrice: 0 },
    { gasCylinderId: G15, quantity: 3, unitPrice: 0 },
  ];

  it('efectivo sin zona: subtotal con la promoción por volumen y sin recargos', async () => {
    const r = await casoDeUso.execute(
      { items, paymentMethod: PaymentMethod.CASH },
      DIST,
      CLIENTE,
    );
    // 2 × 10000 + 3 × 13500 (15000 − 10%)
    expect(r.items.map((i) => i.subtotal)).toEqual([20000, 40500]);
    // El porcentaje de la promoción aplicada lo informa el back; sin promoción, null.
    expect(r.items.map((i) => i.discountPercentage)).toEqual([null, 10]);
    expect(r).toMatchObject({
      subtotal: 60500,
      zone: null,
      zoneSurcharge: 0,
      paymentSurcharge: 0,
      deposit: 0,
      total: 60500,
      balance: 60500,
    });
  });

  describe('fromCart', () => {
    it('cotiza los ítems del carrito del cliente, sin bloquearlo', async () => {
      const r = await casoDeUso.execute(
        { fromCart: true, paymentMethod: PaymentMethod.CASH },
        DIST,
        CLIENTE,
      );

      expect(cart.itemsParaPedido).toHaveBeenCalledWith(
        manager,
        CLIENTE.userId,
        DIST,
        false,
      );
      expect(r.items).toHaveLength(1);
      expect(r.total).toBe(20000);
    });

    it.each([
      ['con items a la vez', { items, fromCart: true }],
      ['con orderId', { fromCart: true, orderId: 'o-1' }],
      ['sin items ni fromCart', {}],
    ])('es 400 %s', async (_caso, extra) => {
      await expect(
        casoDeUso.execute(
          { paymentMethod: PaymentMethod.CASH, ...extra },
          DIST,
          CLIENTE,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('el +10% del medio de pago se aplica sobre subtotal + recargo de zona', async () => {
    zona = {
      id: 'z1',
      name: 'Zona norte',
      type: CoverageZoneSurchargeType.PERCENTAGE,
      value: 5,
    };
    const r = await casoDeUso.execute(
      { items, addressId: 'dir-1', paymentMethod: PaymentMethod.TRANSFER },
      DIST,
      CLIENTE,
    );
    // zona: 5% de 60500 = 3025 → base 63525 → +10% = 69877,50
    expect(r.zoneSurcharge).toBe(3025);
    expect(r.zone).toMatchObject({ coverageZoneId: 'z1', amount: 3025 });
    expect(r.paymentSurcharge).toBe(6352.5);
    expect(r.total).toBe(69877.5);
    expect(r.subtotal + r.zoneSurcharge + r.paymentSurcharge).toBe(r.total);
  });

  it('recargo de zona fijo + mercadopago', async () => {
    zona = {
      id: 'z2',
      name: 'Rural',
      type: CoverageZoneSurchargeType.FIXED,
      value: 1500,
    };
    const r = await casoDeUso.execute(
      {
        items: [{ gasCylinderId: G10, quantity: 1, unitPrice: 0 }],
        addressId: 'dir-1',
        paymentMethod: PaymentMethod.MERCADOPAGO,
      },
      DIST,
      CLIENTE,
    );
    expect(r.total).toBe(12650); // (10000 + 1500) × 1,1
    expect(r.paymentSurcharge).toBe(1150);
  });

  it.each([
    [0, PaymentMethod.TRANSFER, 0],
    [7.5, PaymentMethod.TRANSFER, 1500],
    [7.5, PaymentMethod.MERCADOPAGO, 1500],
    [12.34, PaymentMethod.TRANSFER, 2468],
    [30, PaymentMethod.MERCADOPAGO, 6000],
  ])(
    'el recargo sale del parámetro de la distribuidora: %s %% con %s',
    async (porcentaje, medio, recargo) => {
      parametrosDeRecargo = {
        transferPercentage: porcentaje,
        mercadoPagoPercentage: porcentaje,
        cashPercentage: 0,
      };
      const r = await casoDeUso.execute(
        {
          items: [{ gasCylinderId: G10, quantity: 2, unitPrice: 0 }],
          paymentMethod: medio,
        },
        DIST,
        CLIENTE,
      );
      expect(r.paymentSurchargePercentage).toBe(porcentaje);
      expect(r.paymentSurcharge).toBe(recargo);
      expect(r.total).toBe(20000 + recargo);
    },
  );

  it('el efectivo lleva su propio porcentaje, que puede ser mayor a cero', async () => {
    parametrosDeRecargo = { cashPercentage: 2.5 };
    const r = await casoDeUso.execute(
      {
        items: [{ gasCylinderId: G10, quantity: 2, unitPrice: 0 }],
        paymentMethod: PaymentMethod.CASH,
      },
      DIST,
      CLIENTE,
    );
    expect(r.paymentSurchargePercentage).toBe(2.5);
    expect(r.total).toBe(20500);
  });

  it('una reserva descuenta la seña del saldo', async () => {
    const r = await casoDeUso.execute(
      {
        items: [{ gasCylinderId: G10, quantity: 1, unitPrice: 0 }],
        paymentMethod: PaymentMethod.CASH,
        isReservation: true,
        scheduledDate: '2026-12-01',
        depositAmount: 3000,
      },
      DIST,
      CLIENTE,
    );
    expect(r).toMatchObject({ deposit: 3000, total: 10000, balance: 7000 });
  });

  it.each([[undefined], [0]])(
    'una reserva con MercadoPago y seña %s se rechaza con 400; con seña mayor a cero se cotiza',
    async (depositAmount) => {
      const cotizarCon = (sena?: number) =>
        casoDeUso.execute(
          {
            items: [{ gasCylinderId: G10, quantity: 1, unitPrice: 0 }],
            paymentMethod: PaymentMethod.MERCADOPAGO,
            isReservation: true,
            scheduledDate: '2026-12-01',
            depositAmount: sena,
          },
          DIST,
          CLIENTE,
        );
      await expect(cotizarCon(depositAmount)).rejects.toThrow(
        'Una reserva con MercadoPago necesita una seña mayor a cero',
      );
      await expect(cotizarCon(100)).resolves.toMatchObject({ deposit: 100 });
    },
  );

  it('una seña mayor al total se rechaza con 400; igual al total, se cotiza', async () => {
    const cotizarCon = (depositAmount: number) =>
      casoDeUso.execute(
        {
          items: [{ gasCylinderId: G10, quantity: 1, unitPrice: 0 }],
          paymentMethod: PaymentMethod.CASH,
          isReservation: true,
          scheduledDate: '2026-12-01',
          depositAmount,
        },
        DIST,
        CLIENTE,
      );
    await expect(cotizarCon(10000.01)).rejects.toThrow(
      'La seña ($10000.01) no puede superar el total del pedido ($10000.00)',
    );
    await expect(cotizarCon(10000)).resolves.toMatchObject({
      deposit: 10000,
      balance: 0,
    });
  });

  it('no escribe nada: sólo lee el catálogo', async () => {
    await casoDeUso.execute(
      { items, paymentMethod: PaymentMethod.CASH },
      DIST,
      CLIENTE,
    );
    expect(stock.leerParaCotizar).toHaveBeenCalledTimes(2);
  });

  it('sin X-Distributor usa la distribuidora por defecto, como el alta', async () => {
    const r = await casoDeUso.execute(
      { items, paymentMethod: PaymentMethod.CASH },
      null,
      CLIENTE,
    );
    expect(distributors.getDefault).toHaveBeenCalled();
    expect(r.total).toBe(60500);
  });

  it('una garrafa de otra distribuidora se rechaza como en el alta', async () => {
    await expect(
      casoDeUso.execute(
        { items, paymentMethod: PaymentMethod.CASH },
        'otra-distribuidora',
        CLIENTE,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('sin stock se rechaza como en el alta', async () => {
    await expect(
      casoDeUso.execute(
        {
          items: [{ gasCylinderId: G10, quantity: 999, unitPrice: 0 }],
          paymentMethod: PaymentMethod.CASH,
        },
        DIST,
        CLIENTE,
      ),
    ).rejects.toBeInstanceOf(InsufficientStockError);
  });

  it('un cliente no cotiza para otro', async () => {
    await expect(
      casoDeUso.execute(
        { items, paymentMethod: PaymentMethod.CASH, customerId: 'otro' },
        DIST,
        CLIENTE,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('con addressId, la dirección tiene que ser del cliente', async () => {
    addresses.buscarDelUsuario.mockResolvedValue(null);
    await expect(
      casoDeUso.execute(
        { items, addressId: 'ajena', paymentMethod: PaymentMethod.CASH },
        DIST,
        CLIENTE,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(addresses.buscarDelUsuario).toHaveBeenCalledWith('ajena', 'cli-1');
  });

  it('el admin con addressId tiene que indicar el cliente', async () => {
    await expect(
      casoDeUso.execute(
        { items, addressId: 'dir-1', paymentMethod: PaymentMethod.CASH },
        DIST,
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await casoDeUso.execute(
      {
        items,
        addressId: 'dir-1',
        customerId: 'cli-9',
        paymentMethod: PaymentMethod.CASH,
      },
      DIST,
      ADMIN,
    );
    expect(addresses.buscarDelUsuario).toHaveBeenCalledWith('dir-1', 'cli-9');
  });

  it('una reserva sin fecha se rechaza', async () => {
    await expect(
      casoDeUso.execute(
        { items, paymentMethod: PaymentMethod.CASH, isReservation: true },
        DIST,
        CLIENTE,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('con una garrafa de OTRA distribuidora y sin stock se informa "no pertenece", no "sin stock"', async () => {
    await expect(
      casoDeUso.execute(
        {
          items: [{ gasCylinderId: G10, quantity: 9999, unitPrice: 0 }],
          paymentMethod: PaymentMethod.CASH,
        },
        'otra-distribuidora',
        CLIENTE,
      ),
    ).rejects.toThrow(/no pertenece a la distribuidora/);
  });

  it('valida la franja como el alta: sin fecha, que sea usable; con fecha, que tenga cupo', async () => {
    await casoDeUso.execute(
      { items, paymentMethod: PaymentMethod.CASH, timeSlotId: 'franja-1' },
      DIST,
      CLIENTE,
    );
    expect(timeSlots.assertSlotUsableTx).toHaveBeenCalledWith(
      expect.anything(),
      'franja-1',
      DIST,
    );
    await casoDeUso.execute(
      {
        items,
        paymentMethod: PaymentMethod.CASH,
        timeSlotId: 'franja-1',
        scheduledDate: '2030-01-01',
      },
      DIST,
      CLIENTE,
    );
    expect(timeSlots.assertSlotAvailable).toHaveBeenCalledWith(
      'franja-1',
      '2030-01-01',
      DIST,
    );
  });

  it('una franja inválida o completa rechaza la cotización', async () => {
    timeSlots.assertSlotAvailable.mockRejectedValue(
      new BadRequestException('La franja está completa'),
    );
    await expect(
      casoDeUso.execute(
        {
          items,
          paymentMethod: PaymentMethod.CASH,
          timeSlotId: 'f',
          scheduledDate: '2030-01-01',
        },
        DIST,
        CLIENTE,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sin stock se rechaza después de validar la distribuidora', async () => {
    await expect(
      casoDeUso.execute(
        {
          items: [{ gasCylinderId: G10, quantity: 999, unitPrice: 0 }],
          paymentMethod: PaymentMethod.CASH,
        },
        DIST,
        CLIENTE,
      ),
    ).rejects.toBeInstanceOf(InsufficientStockError);
  });

  describe('cotización de edición (orderId)', () => {
    const PEDIDO = 'ped-1';
    const pedido = (over: Record<string, unknown> = {}) => ({
      orderId: PEDIDO,
      customerId: CLIENTE.userId,
      distributorId: DIST,
      addressId: 'dir-1',
      status: OrderStatus.PENDING,
      deliveryId: null,
      paymentMethod: PaymentMethod.CASH,
      paymentStatus: PaymentStatus.PENDING,
      timeSlotId: 'franja-1',
      scheduledDate: '2020-01-01',
      zoneSurchargeType: null,
      zoneSurchargeValue: null,
      zoneSurchargeAmount: 0,
      coverageZoneId: null,
      zoneName: null,
      depositAmount: 0,
      depositPaid: false,
      ...over,
    });
    const cotizar = (over: Record<string, unknown> = {}, actor = CLIENTE) =>
      casoDeUso.execute(
        {
          orderId: PEDIDO,
          items: [{ gasCylinderId: G10, quantity: 2, unitPrice: 0 }],
          paymentMethod: PaymentMethod.CASH,
          ...over,
        },
        null,
        actor,
      );
    const reservadoPrevio = (cantidad: number) =>
      manager.find.mockResolvedValue([
        { gasCylinderId: G10, quantity: cantidad },
      ]);

    beforeEach(() => {
      manager.findOne.mockResolvedValue(pedido());
      reservadoPrevio(2);
    });

    it('franja propia llena y ya terminada (fecha pasada): sin cambiar la agenda no se valida ni se rechaza', async () => {
      timeSlots.assertSlotAvailable.mockRejectedValue(
        new BadRequestException('completa'),
      );
      const r = await cotizar();
      expect(r.total).toBe(20000);
      expect(timeSlots.assertSlotAvailable).not.toHaveBeenCalled();
      expect(timeSlots.assertSlotUsableTx).not.toHaveBeenCalled();
    });

    it('si cambia la fecha o la franja, sí se valida', async () => {
      await cotizar({ scheduledDate: '2099-01-01' });
      expect(timeSlots.assertSlotAvailable).toHaveBeenCalledWith(
        'franja-1',
        '2099-01-01',
        DIST,
      );
      await cotizar({ timeSlotId: 'franja-2', scheduledDate: '2099-01-01' });
      expect(timeSlots.assertSlotUsableTx).toHaveBeenCalled();
      timeSlots.assertSlotAvailable.mockRejectedValue(
        new BadRequestException('completa'),
      );
      await expect(
        cotizar({ scheduledDate: '2099-01-02' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('un pedido sin fecha agendada no recibe una si el cuerpo no la trae', async () => {
      manager.findOne.mockResolvedValue(
        pedido({ timeSlotId: null, scheduledDate: null }),
      );
      await cotizar();
      expect(timeSlots.assertSlotAvailable).not.toHaveBeenCalled();
    });

    it.each([
      ['igual (delta 0)', 2, 50],
      ['menor (delta negativo)', 1, 0],
      ['igual con el vendible en cero', 2, 0],
    ])(
      'stock justo, cantidad %s: se cotiza',
      async (_n, cantidad, vendible) => {
        manager.find.mockResolvedValue([{ gasCylinderId: G10, quantity: 2 }]);
        stock.leerParaCotizar.mockResolvedValue(garrafa({ stock: vendible }));
        const r = await cotizar({
          items: [{ gasCylinderId: G10, quantity: cantidad, unitPrice: 0 }],
        });
        expect(r.items[0].quantity).toBe(cantidad);
      },
    );

    it('subir la cantidad compara sólo la diferencia contra el vendible', async () => {
      stock.leerParaCotizar.mockResolvedValue(garrafa({ stock: 1 }));
      const items3 = [{ gasCylinderId: G10, quantity: 3, unitPrice: 0 }];
      await expect(cotizar({ items: items3 })).resolves.toBeDefined();
      const items4 = [{ gasCylinderId: G10, quantity: 4, unitPrice: 0 }];
      await expect(cotizar({ items: items4 })).rejects.toBeInstanceOf(
        InsufficientStockError,
      );
    });

    it('el pedido de otro cliente o de otra distribuidora es 404; inexistente también', async () => {
      manager.findOne.mockResolvedValue(pedido({ customerId: 'otro' }));
      await expect(cotizar()).rejects.toBeInstanceOf(NotFoundException);
      manager.findOne.mockResolvedValue(pedido());
      await expect(
        casoDeUso.execute(
          {
            orderId: PEDIDO,
            items,
            paymentMethod: PaymentMethod.CASH,
          },
          'otra-dist',
          ADMIN,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      manager.findOne.mockResolvedValue(null);
      await expect(cotizar()).rejects.toBeInstanceOf(NotFoundException);
    });

    it('un pedido no editable es 409 con el mensaje del PATCH', async () => {
      manager.findOne.mockResolvedValue(pedido({ deliveryId: 'chofer-1' }));
      await expect(cotizar()).rejects.toThrow(
        'El pedido ya fue tomado por un repartidor: no se puede modificar',
      );
      manager.findOne.mockResolvedValue(
        pedido({ paymentMethod: PaymentMethod.MERCADOPAGO }),
      );
      await expect(cotizar()).rejects.toBeInstanceOf(ConflictException);
    });

    it('sin dirección en el cuerpo usa la zona guardada del pedido', async () => {
      manager.findOne.mockResolvedValue(
        pedido({
          zoneSurchargeType: CoverageZoneSurchargeType.FIXED,
          zoneSurchargeValue: 500,
          coverageZoneId: 'z1',
          zoneName: 'Zona norte',
        }),
      );
      const r = await cotizar();
      expect(r.zoneSurcharge).toBe(500);
      expect(r.total).toBe(20500);
      expect(addresses.buscarDelUsuario).not.toHaveBeenCalled();
    });

    it('editar sin cambiar de medio conserva el % con que se creó el pedido, aunque el parámetro haya cambiado', async () => {
      parametrosDeRecargo = { transferPercentage: 3 };
      manager.findOne.mockResolvedValue(
        pedido({
          paymentMethod: PaymentMethod.TRANSFER,
          paymentSurchargePercentage: 7.5,
        }),
      );
      const r = await cotizar({ paymentMethod: PaymentMethod.TRANSFER });
      expect(r.paymentSurchargePercentage).toBe(7.5);
      expect(r.total).toBe(21500);
    });

    it('un pedido anterior a la parametrización conserva el 10 % online que regía', async () => {
      parametrosDeRecargo = { transferPercentage: 3 };
      manager.findOne.mockResolvedValue(
        pedido({
          paymentMethod: PaymentMethod.TRANSFER,
          paymentSurchargePercentage: null,
          paymentSurchargeAmount: 2000,
        }),
      );
      const r = await cotizar({ paymentMethod: PaymentMethod.TRANSFER });
      expect(r.paymentSurchargePercentage).toBe(10);
      expect(r.total).toBe(22000);
    });

    it('un pedido anterior que se cobró sin recargo (monto 0) sigue en 0 % al editarlo', async () => {
      manager.findOne.mockResolvedValue(
        pedido({
          paymentMethod: PaymentMethod.TRANSFER,
          paymentSurchargePercentage: null,
          paymentSurchargeAmount: 0,
        }),
      );
      const r = await cotizar({ paymentMethod: PaymentMethod.TRANSFER });
      expect(r.paymentSurchargePercentage).toBe(0);
      expect(r.total).toBe(20000);
    });

    it('cambiar de medio de pago toma el % vigente del medio nuevo', async () => {
      parametrosDeRecargo = { transferPercentage: 3 };
      manager.findOne.mockResolvedValue(
        pedido({
          paymentMethod: PaymentMethod.CASH,
          paymentSurchargePercentage: 0,
        }),
      );
      const r = await cotizar({ paymentMethod: PaymentMethod.TRANSFER });
      expect(r.paymentSurchargePercentage).toBe(3);
      expect(r.total).toBe(20600);
    });

    it('con la seña paga, un total por debajo de la seña es 409', async () => {
      manager.findOne.mockResolvedValue(
        pedido({ depositPaid: true, depositAmount: 30000 }),
      );
      await expect(cotizar()).rejects.toThrow(
        'El total no puede quedar por debajo de la seña ya pagada',
      );
    });
  });

  describe('modalidad express (CU-148)', () => {
    const unaGarrafa = [{ gasCylinderId: G10, quantity: 1, unitPrice: 0 }];

    it('suma el recargo express al final y lo informa aparte', async () => {
      const r = await casoDeUso.execute(
        {
          items: unaGarrafa,
          paymentMethod: PaymentMethod.MERCADOPAGO,
          addressId: 'dir-1',
          deliveryMode: OrderDeliveryMode.EXPRESS,
        },
        DIST,
        CLIENTE,
      );

      expect(r.deliveryMode).toBe(OrderDeliveryMode.EXPRESS);
      expect(r.expressSurcharge).toBe(1500);
      // 10000 + 10% por MercadoPago + 1500 sin el 10%
      expect(r.paymentSurcharge).toBe(1000);
      expect(r.total).toBe(12500);
    });

    it('la cotización común no lleva recargo ni evalúa el express', async () => {
      const r = await casoDeUso.execute(
        { items: unaGarrafa, paymentMethod: PaymentMethod.CASH },
        DIST,
        CLIENTE,
      );

      expect(r.deliveryMode).toBe(OrderDeliveryMode.STANDARD);
      expect(r.expressSurcharge).toBe(0);
      expect(r.total).toBe(10000);
      expect(expressAvailability.evaluar).not.toHaveBeenCalled();
    });

    it('si no está disponible responde 409 con el motivo', async () => {
      expressAvailability.evaluar.mockResolvedValue({
        available: false,
        reason: 'out_of_hours',
        message: 'Fuera del horario de servicio express',
        settings: { surchargeAmount: 1500 },
      });

      const error = await casoDeUso
        .execute(
          {
            items: unaGarrafa,
            paymentMethod: PaymentMethod.CASH,
            addressId: 'dir-1',
            deliveryMode: OrderDeliveryMode.EXPRESS,
          },
          DIST,
          CLIENTE,
        )
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        reason: 'out_of_hours',
      });
    });

    it('exige la dirección para evaluar el express', async () => {
      await expect(
        casoDeUso.execute(
          {
            items: unaGarrafa,
            paymentMethod: PaymentMethod.CASH,
            deliveryMode: OrderDeliveryMode.EXPRESS,
          },
          DIST,
          CLIENTE,
        ),
      ).rejects.toThrow(
        'Indicá la dirección para cotizar la modalidad express',
      );
    });

    it('no se combina con una reserva', async () => {
      await expect(
        casoDeUso.execute(
          {
            items: unaGarrafa,
            paymentMethod: PaymentMethod.CASH,
            addressId: 'dir-1',
            deliveryMode: OrderDeliveryMode.EXPRESS,
            isReservation: true,
            scheduledDate: '2099-01-01',
          },
          DIST,
          CLIENTE,
        ),
      ).rejects.toThrow(/no se agenda/);
    });

    it('no se elige al editar un pedido', async () => {
      manager.findOne.mockResolvedValue({
        orderId: 'ord-1',
        customerId: CLIENTE.userId,
        distributorId: DIST,
        status: OrderStatus.PENDING,
        deliveryId: null,
        paymentMethod: PaymentMethod.CASH,
        paymentStatus: PaymentStatus.PENDING,
        deliveryMode: OrderDeliveryMode.STANDARD,
        depositAmount: 0,
        depositPaid: false,
        addressId: 'dir-1',
        zoneSurchargeAmount: 0,
      });

      await expect(
        casoDeUso.execute(
          {
            orderId: 'ord-1',
            items: unaGarrafa,
            paymentMethod: PaymentMethod.CASH,
            deliveryMode: OrderDeliveryMode.EXPRESS,
          },
          DIST,
          CLIENTE,
        ),
      ).rejects.toThrow(/al editarlo/);
    });

    it('cotizar la edición de un pedido express responde 409 (no se edita)', async () => {
      manager.findOne.mockResolvedValue({
        orderId: 'ord-1',
        customerId: CLIENTE.userId,
        distributorId: DIST,
        status: OrderStatus.PENDING,
        deliveryId: null,
        paymentMethod: PaymentMethod.CASH,
        paymentStatus: PaymentStatus.PENDING,
        deliveryMode: OrderDeliveryMode.EXPRESS,
      });

      await expect(
        casoDeUso.execute(
          {
            orderId: 'ord-1',
            items: unaGarrafa,
            paymentMethod: PaymentMethod.CASH,
          },
          DIST,
          CLIENTE,
        ),
      ).rejects.toThrow(/express no se edita/);
    });
  });
});
