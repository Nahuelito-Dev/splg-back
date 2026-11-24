import { OrderMapper } from './order.mapper';
import { Order, OrderStatus } from './entities/order.entity';

/** La nueva visita después de una entrega fallida (C5) sale en el pedido. */
describe('OrderMapper · nueva visita', () => {
  const base = (over: Partial<Order>): Order =>
    ({
      orderId: 'o-1',
      status: OrderStatus.PENDING,
      totalAmount: '1000',
      deliveryId: null,
      items: [],
      failedVisitCount: 1,
      revisitStatus: 'proposed',
      scheduledDate: '2026-11-26',
      timeSlotId: 'f-1',
      timeSlot: { name: 'Mañana', startTime: '09:00:00', endTime: '13:00:00' },
      ...over,
    }) as unknown as Order;

  it('un pedido sin visitas fallidas no trae nueva visita', () => {
    expect(
      OrderMapper.toDto(base({ revisitStatus: null, failedVisitCount: 0 }))
        .revisit,
    ).toBeNull();
  });

  it('la propuesta: día, franja y que el cliente puede contestar', () => {
    expect(OrderMapper.toDto(base({})).revisit).toEqual({
      status: 'proposed',
      failedVisitCount: 1,
      scheduledDate: '2026-11-26',
      timeSlotId: 'f-1',
      timeSlotName: 'Mañana',
      windowStart: '09:00:00',
      windowEnd: '13:00:00',
      canRespond: true,
    });
  });

  it('confirmada, o con chofer otra vez: ya no se contesta', () => {
    expect(
      OrderMapper.toDto(base({ revisitStatus: 'confirmed' })).revisit,
    ).toMatchObject({ status: 'confirmed', canRespond: false });
    expect(
      OrderMapper.toDto(
        base({
          status: OrderStatus.ACCEPTED,
          deliveryId: 'd-1',
          acceptedAt: new Date(),
        }),
      ).revisit,
    ).toMatchObject({ canRespond: false, scheduledDate: '2026-11-26' });
  });

  it('con la decisión en el admin no muestra fecha ni franja', () => {
    expect(
      OrderMapper.toDto(
        base({ revisitStatus: 'awaiting_admin', failedVisitCount: 2 }),
      ).revisit,
    ).toEqual({
      status: 'awaiting_admin',
      failedVisitCount: 2,
      scheduledDate: null,
      timeSlotId: null,
      timeSlotName: null,
      windowStart: null,
      windowEnd: null,
      canRespond: false,
    });
  });

  it('entregado o cancelado: la nueva visita ya no aplica', () => {
    expect(
      OrderMapper.toDto(
        base({ status: OrderStatus.DELIVERED, deliveredAt: new Date() }),
      ).revisit,
    ).toBeNull();
    expect(
      OrderMapper.toDto(base({ status: OrderStatus.CANCELLED })).revisit,
    ).toBeNull();
  });
});
