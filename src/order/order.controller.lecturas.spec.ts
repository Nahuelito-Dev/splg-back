import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { OrderController } from './order.controller';
import { Order, OrderStatus } from './entities/order.entity';
import { RoleType } from '../common/constants/role-type.enum';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import type { OrderResponseDto } from './dto/order-response.dto';

const usuario = (role: RoleType) =>
  ({ user_id: 'u1', role }) as unknown as AuthenticatedUser;

const pedido = (status: OrderStatus) =>
  ({ orderId: 'o1', status, totalAmount: 100, items: [] }) as unknown as Order;

describe('OrderController · cancelledBy en la respuesta de la cancelación', () => {
  let orderService: {
    assertDeLaDistribuidora: jest.Mock;
    cancelOrder: jest.Mock;
  };
  let controller: OrderController;

  beforeEach(() => {
    orderService = {
      assertDeLaDistribuidora: jest.fn().mockResolvedValue(undefined),
      cancelOrder: jest.fn(),
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
      { completar: jest.fn() } as never,
    );
  });

  it.each([
    [RoleType.CUSTOMER, 'customer'],
    [RoleType.ADMIN, 'admin'],
    [RoleType.SUPER_ADMIN, 'admin'],
  ])('PATCH /cancel de %s responde cancelledBy %s', async (rol, esperado) => {
    orderService.cancelOrder.mockResolvedValue(pedido(OrderStatus.CANCELLED));
    const r = await controller.cancel(usuario(rol), 'o1', {}, 'd1');
    expect(r.cancelledBy).toBe(esperado);
  });

  it('si el chofer "cancela" el pedido vuelve a pendiente y cancelledBy es null', async () => {
    orderService.cancelOrder.mockResolvedValue(pedido(OrderStatus.PENDING));
    const r = await controller.cancel(
      usuario(RoleType.DELIVERY),
      'o1',
      {},
      'd1',
    );
    expect(r.cancelledBy).toBeNull();
  });

  it('DELETE /orders/:id (admin) también lo trae', async () => {
    orderService.cancelOrder.mockResolvedValue(pedido(OrderStatus.CANCELLED));
    const r = await controller.cancelOrder(usuario(RoleType.ADMIN), 'o1', 'd1');
    expect(r.cancelledBy).toBe('admin');
  });
});

describe('OrderController · pedido en curso del chofer', () => {
  const res = () => {
    const status = jest.fn();
    return { status, objeto: { status } as unknown as Response };
  };
  let orderService: { findCurrentOfDriver: jest.Mock };
  let controller: OrderController;

  beforeEach(() => {
    orderService = { findCurrentOfDriver: jest.fn() };
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
      { completar: jest.fn() } as never,
    );
  });

  it('devuelve el pedido en curso del chofer autenticado y de su distribuidora', async () => {
    const dto = { id: 'o1' } as OrderResponseDto;
    orderService.findCurrentOfDriver.mockResolvedValue(dto);
    const { status, objeto } = res();
    await expect(
      controller.findMyActive(usuario(RoleType.DELIVERY), 'd1', objeto),
    ).resolves.toBe(dto);
    expect(orderService.findCurrentOfDriver).toHaveBeenCalledWith('u1', 'd1');
    expect(status).not.toHaveBeenCalled();
  });

  it('sin pedido en curso responde 204', async () => {
    orderService.findCurrentOfDriver.mockResolvedValue(null);
    const { status, objeto } = res();
    await expect(
      controller.findMyActive(usuario(RoleType.DELIVERY), 'd1', objeto),
    ).resolves.toBeUndefined();
    expect(status).toHaveBeenCalledWith(HttpStatus.NO_CONTENT);
  });

  it('es sólo del chofer', () => {
    const handler = (
      OrderController.prototype as unknown as Record<string, object>
    )['findMyActive'];
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([
      RoleType.DELIVERY,
    ]);
  });
});

describe('OrderController · historial de estados', () => {
  let orderService: { getStatusHistory: jest.Mock };
  let controller: OrderController;

  beforeEach(() => {
    orderService = { getStatusHistory: jest.fn().mockResolvedValue([]) };
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
      { completar: jest.fn() } as never,
    );
  });

  it.each([
    [RoleType.CUSTOMER, 'u1', undefined, false],
    [RoleType.DELIVERY, undefined, 'u1', false],
    [RoleType.ADMIN, undefined, undefined, true],
    [RoleType.SUPER_ADMIN, undefined, undefined, true],
  ])(
    'aplica la regla de lectura del pedido para %s',
    async (rol, cliente, chofer, nombres) => {
      await controller.statusHistory('o1', usuario(rol), 'd1');
      expect(orderService.getStatusHistory).toHaveBeenCalledWith(
        'o1',
        'd1',
        cliente,
        chofer,
        nombres,
      );
    },
  );
});
