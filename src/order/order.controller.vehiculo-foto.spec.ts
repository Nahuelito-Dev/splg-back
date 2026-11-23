import { OrderController } from './order.controller';
import { Order, OrderStatus } from './entities/order.entity';
import type { OrderResponseDto } from './dto/order-response.dto';

const pedido = (id: string, carId: string | null) =>
  ({
    orderId: id,
    distributorId: 'd1',
    status: OrderStatus.ACCEPTED,
    totalAmount: 100,
    items: [],
    vehicleCarId: carId,
  }) as unknown as Order;

/** Firma de mentira: pone la URL según el id del auto. */
const completar = jest.fn((dtos: readonly OrderResponseDto[]) => {
  for (const d of dtos) {
    if (d.vehicle) d.vehicle.photoUrl = `https://s3.test/${d.vehicle.carId}`;
  }
  return Promise.resolve();
});

const completarProducto = jest.fn(() => Promise.resolve());

describe('OrderController · foto del vehículo en la respuesta', () => {
  let orderService: {
    findAll: jest.Mock;
    updateStatus: jest.Mock;
    assertDeLaDistribuidora: jest.Mock;
  };
  let controller: OrderController;

  beforeEach(() => {
    completar.mockClear();
    completarProducto.mockClear();
    orderService = {
      findAll: jest.fn(),
      updateStatus: jest.fn(),
      assertDeLaDistribuidora: jest.fn().mockResolvedValue(undefined),
    };
    controller = new OrderController(
      orderService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { completar } as never,
      { completar: completarProducto } as never,
    );
  });

  it('GET /orders: la foto de los productos se completa una sola vez para toda la lista', async () => {
    orderService.findAll.mockResolvedValue({
      orders: [pedido('o1', 'c1'), pedido('o2', 'c2')],
      total: 2,
    });
    const r = await controller.findAll({} as never, 'd1');
    expect(completarProducto).toHaveBeenCalledTimes(1);
    expect(completarProducto).toHaveBeenCalledWith(r.orders);
  });

  it('PATCH /orders/:id/status: la respuesta también pasa por la foto de los productos', async () => {
    orderService.updateStatus.mockResolvedValue(pedido('o1', 'c1'));
    const r = await controller.updateStatus(
      { user_id: 'u1', role: 'admin' } as never,
      'o1',
      { status: 'accepted' } as never,
      'd1',
    );
    expect(completarProducto).toHaveBeenCalledWith([r]);
  });

  it('GET /orders: completa la foto de toda la lista en una sola llamada (sin N+1)', async () => {
    orderService.findAll.mockResolvedValue({
      orders: [pedido('o1', 'c1'), pedido('o2', 'c2'), pedido('o3', null)],
      total: 3,
    });
    const r = await controller.findAll({} as never, 'd1');
    expect(completar).toHaveBeenCalledTimes(1);
    expect(r.orders.map((o) => o.vehicle?.photoUrl ?? null)).toEqual([
      'https://s3.test/c1',
      'https://s3.test/c2',
      null,
    ]);
  });

  it('PATCH /orders/:id/status (aceptar): la respuesta con vehículo lleva photoUrl', async () => {
    orderService.updateStatus.mockResolvedValue(pedido('o1', 'c1'));
    const r = await controller.updateStatus(
      { user_id: 'u1', role: 'admin' } as never,
      'o1',
      { status: 'accepted' } as never,
      'd1',
    );
    expect(r.vehicle?.photoUrl).toBe('https://s3.test/c1');
  });
});
