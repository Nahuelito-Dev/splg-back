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
});
