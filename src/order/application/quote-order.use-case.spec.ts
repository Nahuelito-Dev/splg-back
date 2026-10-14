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
import { PaymentMethod } from '../entities/order.entity';
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
  let casoDeUso: QuoteOrderUseCase;

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
    const alta = Object.assign(Object.create(CreateOrderUseCase.prototype), {
      pricing: new OrderPricingService(),
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
      { manager: {} } as never,
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
});
