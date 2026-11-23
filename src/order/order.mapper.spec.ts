import { OrderMapper } from './order.mapper';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentType,
  PaymentStatus,
  OrderDeliveryMode,
} from './entities/order.entity';
import type { User } from '../users/entities/user.entity';
import { CoverageZoneSurchargeType } from '../coverage-zone/entities/coverage-zone.entity';

/**
 * Lo nuevo para el panel: `customer`, `cancellation_reason`, `accepted_at` y
 * `on_the_way_at`. El resto del contrato (claves de siempre) no se toca acá,
 * lo cubre el uso real de las apps.
 */
describe('OrderMapper · datos del panel', () => {
  const pedidoBase = (): Order =>
    ({
      orderId: 'o1',
      distributorId: 'd1',
      totalAmount: 22600,
      createdAt: new Date('2026-09-01T12:00:00Z'),
      deliveryInstructions: null,
      notes: null,
      deliveryId: null,
      deliveredAt: null,
      delivery: null,
      status: OrderStatus.PENDING,
      scheduledDate: null,
      depositAmount: 0,
      depositPaid: false,
      paymentType: PaymentType.CASH,
      paymentMethod: PaymentMethod.CASH,
      paymentStatus: PaymentStatus.PENDING,
      address: null,
      timeSlot: null,
      items: [],
      cancellationReason: null,
      acceptedAt: null,
      onTheWayAt: null,
      deliveryMode: OrderDeliveryMode.STANDARD,
    }) as unknown as Order;

  describe('cashToCollect (C4)', () => {
    it('un pedido en efectivo sin cobrar trae el saldo calculado en el back', () => {
      expect(OrderMapper.toDto(pedidoBase()).cashToCollect).toBe(22600);
    });

    it('descuenta la seña ya paga', () => {
      const dto = OrderMapper.toDto({
        ...pedidoBase(),
        depositAmount: 5000,
        depositPaid: true,
      });
      expect(dto.cashToCollect).toBe(17600);
    });

    it('una reserva con la seña todavía sin confirmar ya trae el saldo: lo que se paga al entregar', () => {
      const dto = OrderMapper.toDto({
        ...pedidoBase(),
        status: OrderStatus.RESERVED,
        depositAmount: 5000,
        depositPaid: false,
      });
      expect(dto.cashToCollect).toBe(17600);
    });

    it.each([
      ['online', { paymentMethod: PaymentMethod.MERCADOPAGO }],
      ['ya cobrado', { paymentStatus: PaymentStatus.PAID }],
      ['entregado', { status: OrderStatus.DELIVERED }],
      ['cancelado', { status: OrderStatus.CANCELLED }],
    ])('sale null si el pedido está %s', (_caso, cambio) => {
      const dto = OrderMapper.toDto({ ...pedidoBase(), ...cambio });
      expect(dto.cashToCollect).toBeNull();
    });
  });

  it('expone el recargo por medio de pago con el % con que se calculó', () => {
    const dto = OrderMapper.toDto({
      ...pedidoBase(),
      paymentSurchargeAmount: 1500,
      paymentSurchargePercentage: 7.5,
    } as unknown as Order);
    expect(dto.paymentSurchargeAmount).toBe(1500);
    expect(dto.paymentSurchargePercentage).toBe(7.5);
  });

  it('un pedido anterior a la parametrización devuelve el % en null', () => {
    const dto = OrderMapper.toDto({
      ...pedidoBase(),
      paymentSurchargeAmount: 2000,
      paymentSurchargePercentage: null,
    } as unknown as Order);
    expect(dto.paymentSurchargeAmount).toBe(2000);
    expect(dto.paymentSurchargePercentage).toBeNull();
  });

  it('trae los datos del cliente cuando la relación viene cargada', () => {
    const pedido = {
      ...pedidoBase(),
      customer: {
        userId: 'u1',
        fullName: 'Ana Gómez',
        phoneNumber: '+595981000000',
        email: 'ana@example.com',
      } as unknown as User,
    } as Order;

    const dto = OrderMapper.toDto(pedido);

    expect(dto.customer).toEqual({
      userId: 'u1',
      fullName: 'Ana Gómez',
      phoneNumber: '+595981000000',
      email: 'ana@example.com',
    });
  });

  it('customer sale null si la relación no vino cargada (no rompe el contrato)', () => {
    const dto = OrderMapper.toDto(pedidoBase());
    expect(dto.customer).toBeNull();
  });

  it('un cliente dado de baja igual aparece con lo que tenga cargado', () => {
    const pedido = {
      ...pedidoBase(),
      customer: {
        userId: 'u1',
        fullName: null,
        phoneNumber: null,
        email: null,
      } as unknown as User,
    } as Order;

    const dto = OrderMapper.toDto(pedido);

    expect(dto.customer).toEqual({
      userId: 'u1',
      fullName: null,
      phoneNumber: null,
      email: null,
    });
  });

  it('mapea cancellationReason, acceptedAt y onTheWayAt', () => {
    const aceptado = new Date('2026-09-01T12:05:00Z');
    const enCamino = new Date('2026-09-01T12:20:00Z');
    const pedido = {
      ...pedidoBase(),
      cancellationReason: 'El cliente ya no quiere el pedido',
      acceptedAt: aceptado,
      onTheWayAt: enCamino,
    } as Order;

    const dto = OrderMapper.toDto(pedido);

    expect(dto.cancellationReason).toBe('El cliente ya no quiere el pedido');
    expect(dto.acceptedAt).toBe(aceptado);
    expect(dto.onTheWayAt).toBe(enCamino);
  });

  it('cancellationReason/acceptedAt/onTheWayAt salen null por defecto', () => {
    const dto = OrderMapper.toDto(pedidoBase());
    expect(dto.cancellationReason).toBeNull();
    expect(dto.acceptedAt).toBeNull();
    expect(dto.onTheWayAt).toBeNull();
  });

  it('zoneSurcharge sale null y subtotalItems 0 si el pedido no tiene zona (no-op o anterior a la funcionalidad)', () => {
    const dto = OrderMapper.toDto(pedidoBase());
    expect(dto.zoneSurcharge).toBeNull();
    expect(dto.subtotalItems).toBe(0);
  });

  it('zoneSurcharge trae el snapshot de la zona ganadora al pedir', () => {
    const pedido = {
      ...pedidoBase(),
      coverageZoneId: 'z1',
      zoneName: 'Villa Lanús',
      zoneSurchargeType: CoverageZoneSurchargeType.PERCENTAGE,
      zoneSurchargeValue: 10,
      zoneSurchargeAmount: 2000,
      subtotalItems: 20000,
    } as Order;

    const dto = OrderMapper.toDto(pedido);

    expect(dto.zoneSurcharge).toEqual({
      coverageZoneId: 'z1',
      name: 'Villa Lanús',
      type: CoverageZoneSurchargeType.PERCENTAGE,
      value: 10,
      amount: 2000,
    });
    expect(dto.subtotalItems).toBe(20000);
  });

  it('vehicle sale null si el pedido no tiene snapshot de vehículo (sin chofer, o anterior a la funcionalidad)', () => {
    const dto = OrderMapper.toDto(pedidoBase());
    expect(dto.vehicle).toBeNull();
  });

  it('vehicle trae el snapshot tomado al aceptar (decisión de nahue, "vehículo en uso")', () => {
    const pedido = {
      ...pedidoBase(),
      vehicleCarId: 'c1',
      vehiclePatent: 'AB123CD',
      vehicleBrand: 'Honda',
      vehicleModel: 'Wave',
    } as Order;

    const dto = OrderMapper.toDto(pedido);

    expect(dto.vehicle).toEqual({
      carId: 'c1',
      patent: 'AB123CD',
      brand: 'Honda',
      model: 'Wave',
      photoUrl: null,
    });
  });

  it('cada renglón trae unit_price y subtotal guardados, no el precio vigente del catálogo', () => {
    const pedido = {
      ...pedidoBase(),
      items: [
        {
          quantity: 2,
          unitPrice: '14155.00',
          subtotal: 28310,
          gasCylinder: {
            gasCylinderId: 'g1',
            type: '10kg',
            weight: 10,
            price: 14900,
            description: null,
          },
        },
      ],
    } as unknown as Order;

    const [renglon] = OrderMapper.toDto(pedido).items;

    expect(renglon.unitPrice).toBe(14155);
    expect(renglon.subtotal).toBe(28310);
    expect(renglon.cylinder?.price).toBe(14900);
  });

  it('trae la distribuidora del pedido (el super admin la usa para asignar chofer)', () => {
    const dto = OrderMapper.toDto(pedidoBase());
    expect(dto.distributorId).toBe('d1');
  });
});

describe('OrderMapper · medio de pago, estado de pago y editable', () => {
  const base = (over: Partial<Order>): Order =>
    ({
      orderId: 'o1',
      distributorId: 'd1',
      totalAmount: 1000,
      createdAt: new Date('2026-09-01T12:00:00Z'),
      status: OrderStatus.PENDING,
      deliveryId: null,
      paymentType: PaymentType.CASH,
      paymentMethod: PaymentMethod.CASH,
      paymentStatus: PaymentStatus.PENDING,
      items: [],
      ...over,
    }) as unknown as Order;

  it('la transferencia sigue agrupada como online en payment_method y se distingue en paymentMethodDetail', () => {
    const dto = OrderMapper.toDto(
      base({
        paymentType: PaymentType.ONLINE,
        paymentMethod: PaymentMethod.TRANSFER,
      }),
    );
    expect(dto.paymentMethod).toBe('online');
    expect(dto.paymentMethodDetail).toBe('transfer');
    expect(dto.paymentStatus).toBe('pending');
    expect(dto.editable).toBe(true);
  });

  it('efectivo pendiente y sin chofer es editable', () => {
    const dto = OrderMapper.toDto(base({}));
    expect(dto.paymentMethodDetail).toBe('cash');
    expect(dto.editable).toBe(true);
  });

  it.each([
    ['mercadopago', { paymentMethod: PaymentMethod.MERCADOPAGO }],
    ['pago ya cobrado', { paymentStatus: PaymentStatus.PAID }],
    ['pago fallido', { paymentStatus: PaymentStatus.FAILED }],
    ['con chofer', { deliveryId: 'c1' }],
    ['aceptado', { status: OrderStatus.ACCEPTED }],
    ['entregado', { status: OrderStatus.DELIVERED }],
    ['reservado', { status: OrderStatus.RESERVED }],
  ])('no es editable: %s', (_caso, over) => {
    expect(OrderMapper.toDto(base(over)).editable).toBe(false);
  });
});

describe('OrderMapper · quién recibe (CU-128)', () => {
  const base = (over: Partial<Order> = {}): Order =>
    ({
      orderId: 'o1',
      distributorId: 'd1',
      totalAmount: 100,
      createdAt: new Date('2026-09-01T12:00:00Z'),
      status: OrderStatus.PENDING,
      paymentType: PaymentType.CASH,
      paymentMethod: PaymentMethod.CASH,
      paymentStatus: PaymentStatus.PENDING,
      depositAmount: 0,
      items: [],
      receiverName: null,
      receiverDocument: null,
      receiverRelationship: null,
      ...over,
    }) as unknown as Order;

  it('sin datos de quien recibe, receiver es null', () => {
    expect(OrderMapper.toDto(base()).receiver).toBeNull();
  });

  it('con datos los expone completos', () => {
    const dto = OrderMapper.toDto(
      base({
        receiverName: 'María Gómez',
        receiverDocument: '30123456',
        receiverRelationship: 'vecina',
      }),
    );
    expect(dto.receiver).toEqual({
      name: 'María Gómez',
      document: '30123456',
      relationship: 'vecina',
    });
  });
});
