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
    });
  });
});
