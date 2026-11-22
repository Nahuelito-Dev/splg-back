import { OrderMapper } from './order.mapper';
import { Order, OrderStatus } from './entities/order.entity';

/** La prueba de la entrega (quién, cuándo, dónde, a cuántos metros) sale en el pedido. */
describe('OrderMapper · confirmación de la entrega', () => {
  const base = (over: Partial<Order>): Order =>
    ({
      orderId: 'o-1',
      status: OrderStatus.DELIVERED,
      totalAmount: '1000',
      deliveredAt: new Date('2026-11-18T15:00:00Z'),
      items: [],
      ...over,
    }) as unknown as Order;

  const delChofer = () =>
    base({
      deliveryConfirmedByUserId: 'u-chofer',
      deliveryConfirmedByRole: 'delivery',
      deliveryConfirmedPoint: {
        type: 'Point',
        coordinates: [-55.89, -27.36],
      },
      deliveryConfirmedAccuracyM: 8.5,
      deliveryConfirmedDistanceM: 230,
      deliveryConfirmedOutOfRange: true,
    });

  it('al cliente y al chofer no les llega quién confirmó (confirmedByUserId null)', () => {
    const dto = OrderMapper.toDto(delChofer());
    expect(dto.deliveryConfirmation).toMatchObject({
      confirmedByRole: 'delivery',
      confirmedByUserId: null,
      outOfRange: true,
    });
  });

  it('el pedido confirmado por el chofer trae punto, precisión, distancia y marca (al personal, también quién)', () => {
    const dto = OrderMapper.toDto(
      base({
        deliveryConfirmedByUserId: 'u-chofer',
        deliveryConfirmedByRole: 'delivery',
        deliveryConfirmedPoint: {
          type: 'Point',
          coordinates: [-55.89, -27.36],
        },
        deliveryConfirmedAccuracyM: 8.5,
        deliveryConfirmedDistanceM: 230,
        deliveryConfirmedOutOfRange: true,
      }),
      { paraElPersonal: true },
    );
    expect(dto.deliveryConfirmation).toEqual({
      confirmedAt: new Date('2026-11-18T15:00:00Z'),
      confirmedByRole: 'delivery',
      confirmedByUserId: 'u-chofer',
      latitude: -27.36,
      longitude: -55.89,
      accuracyMeters: 8.5,
      distanceMeters: 230,
      outOfRange: true,
    });
  });

  it('la confirmación del admin no lleva ubicación', () => {
    const dto = OrderMapper.toDto(
      base({
        deliveryConfirmedByUserId: 'u-admin',
        deliveryConfirmedByRole: 'admin',
        deliveryConfirmedPoint: null,
        deliveryConfirmedAccuracyM: null,
        deliveryConfirmedDistanceM: null,
        deliveryConfirmedOutOfRange: false,
      }),
    );
    expect(dto.deliveryConfirmation).toMatchObject({
      confirmedByRole: 'admin',
      latitude: null,
      longitude: null,
      outOfRange: false,
    });
  });

  it('un pedido sin confirmación registrada (anterior, o no entregado) es null', () => {
    expect(
      OrderMapper.toDto(base({ deliveryConfirmedByUserId: null }))
        .deliveryConfirmation,
    ).toBeNull();
  });
});
