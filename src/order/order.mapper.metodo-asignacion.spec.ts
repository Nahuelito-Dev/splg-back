import { OrderMapper } from './order.mapper';
import { AssignmentMethod, Order, OrderStatus } from './entities/order.entity';

describe('OrderMapper · método de asignación', () => {
  const pedido = (over: Partial<Order> = {}): Order =>
    ({
      orderId: 'o-1',
      status: OrderStatus.ACCEPTED,
      totalAmount: '1000',
      items: [],
      ...over,
    }) as unknown as Order;

  it('el personal ve cómo se asignó', () => {
    const dto = OrderMapper.toDto(
      pedido({ assignmentMethod: AssignmentMethod.ROUTE_SHEET }),
      { paraElPersonal: true },
    );
    expect(dto.assignmentMethod).toBe('route_sheet');
  });

  it('un pedido anterior al dato sigue en null (no se inventa)', () => {
    const dto = OrderMapper.toDto(pedido({ assignmentMethod: null }), {
      paraElPersonal: true,
    });
    expect(dto.assignmentMethod).toBeNull();
  });

  it('el cliente y el chofer no lo ven', () => {
    const dto = OrderMapper.toDto(
      pedido({ assignmentMethod: AssignmentMethod.AUTOMATIC }),
    );
    expect(dto.assignmentMethod).toBeNull();
  });
});
