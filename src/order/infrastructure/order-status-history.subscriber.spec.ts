import type { DataSource, InsertEvent, UpdateEvent } from 'typeorm';
import { OrderStatusHistorySubscriber } from './order-status-history.subscriber';
import { OrderStatusHistory } from '../entities/order-status-history.entity';
import { Order, OrderStatus } from '../entities/order.entity';
import { auditContext } from '../../audit/data/audit-context';

describe('OrderStatusHistorySubscriber', () => {
  let insert: jest.Mock;
  let subscriber: OrderStatusHistorySubscriber;
  const manager = () => ({ insert }) as never;

  const pedido = (over: Partial<Order> = {}) =>
    ({
      orderId: 'o1',
      status: OrderStatus.PENDING,
      cancellationReason: null,
      ...over,
    }) as Order;

  const conActor = <T>(userId: string | null, fn: () => Promise<T>) =>
    auditContext.run({ userId, ip: null, distributorId: null }, fn);

  beforeEach(() => {
    insert = jest.fn().mockResolvedValue(undefined);
    const subscribers: unknown[] = [];
    subscriber = new OrderStatusHistorySubscriber({
      subscribers,
    } as unknown as DataSource);
  });

  it('escucha sólo los pedidos', () => {
    expect(subscriber.listenTo()).toBe(Order);
  });

  it('el alta asienta null → estado inicial con quien la hizo', async () => {
    await conActor('cliente-1', () =>
      subscriber.afterInsert({
        entity: pedido({ status: OrderStatus.RESERVED }),
        manager: manager(),
      } as unknown as InsertEvent<Order>),
    );
    expect(insert).toHaveBeenCalledWith(OrderStatusHistory, {
      orderId: 'o1',
      fromStatus: null,
      toStatus: OrderStatus.RESERVED,
      changedByUserId: 'cliente-1',
      reason: null,
    });
  });

  it('un cambio de estado asienta desde, hasta y quién', async () => {
    await conActor('chofer-1', () =>
      subscriber.afterUpdate({
        entity: pedido({ status: OrderStatus.ACCEPTED }),
        databaseEntity: pedido({ status: OrderStatus.PENDING }),
        manager: manager(),
      } as unknown as UpdateEvent<Order>),
    );
    expect(insert).toHaveBeenCalledWith(
      OrderStatusHistory,
      expect.objectContaining({
        fromStatus: OrderStatus.PENDING,
        toStatus: OrderStatus.ACCEPTED,
        changedByUserId: 'chofer-1',
      }),
    );
  });

  it('si el estado no cambia no asienta nada', async () => {
    await subscriber.afterUpdate({
      entity: pedido({ status: OrderStatus.PENDING }),
      databaseEntity: pedido({ status: OrderStatus.PENDING }),
      manager: manager(),
    } as unknown as UpdateEvent<Order>);
    expect(insert).not.toHaveBeenCalled();
  });

  it('reasignar el pedido aceptado a otro chofer asienta accepted → accepted', async () => {
    await conActor('admin-1', () =>
      subscriber.afterUpdate({
        entity: pedido({ status: OrderStatus.ACCEPTED, deliveryId: 'B' }),
        databaseEntity: pedido({
          status: OrderStatus.ACCEPTED,
          deliveryId: 'A',
        }),
        manager: manager(),
      } as unknown as UpdateEvent<Order>),
    );
    expect(insert).toHaveBeenCalledWith(OrderStatusHistory, {
      orderId: 'o1',
      fromStatus: OrderStatus.ACCEPTED,
      toStatus: OrderStatus.ACCEPTED,
      changedByUserId: 'admin-1',
      reason: 'Reasignación de chofer',
    });
  });

  it('si el caso de uso puso un motivo, usa ese', async () => {
    await subscriber.afterUpdate({
      entity: pedido({
        status: OrderStatus.ACCEPTED,
        deliveryId: 'B',
        transitionReason: 'Pedido del cliente',
      }),
      databaseEntity: pedido({ status: OrderStatus.ACCEPTED, deliveryId: 'A' }),
      manager: manager(),
    } as unknown as UpdateEvent<Order>);
    expect(insert).toHaveBeenCalledWith(
      OrderStatusHistory,
      expect.objectContaining({ reason: 'Pedido del cliente' }),
    );
  });

  it('mismo estado y mismo chofer no asienta nada', async () => {
    await subscriber.afterUpdate({
      entity: pedido({ status: OrderStatus.ACCEPTED, deliveryId: 'A' }),
      databaseEntity: pedido({ status: OrderStatus.ACCEPTED, deliveryId: 'A' }),
      manager: manager(),
    } as unknown as UpdateEvent<Order>);
    expect(insert).not.toHaveBeenCalled();
  });

  it('una actualización parcial sin estado no asienta nada', async () => {
    await subscriber.afterUpdate({
      entity: { orderId: 'o1' } as Order,
      databaseEntity: pedido(),
      manager: manager(),
    } as unknown as UpdateEvent<Order>);
    expect(insert).not.toHaveBeenCalled();
  });

  it('sin request (cron, webhook) el autor queda en null', async () => {
    await subscriber.afterUpdate({
      entity: pedido({ status: OrderStatus.CANCELLED }),
      databaseEntity: pedido({ status: OrderStatus.PENDING }),
      manager: manager(),
    } as unknown as UpdateEvent<Order>);
    expect(insert).toHaveBeenCalledWith(
      OrderStatusHistory,
      expect.objectContaining({ changedByUserId: null }),
    );
  });

  it('al cancelar usa cancellationReason; transitionReason manda y se limpia', async () => {
    await subscriber.afterUpdate({
      entity: pedido({
        status: OrderStatus.CANCELLED,
        cancellationReason: 'Pidió otra cosa',
      }),
      databaseEntity: pedido({ status: OrderStatus.PENDING }),
      manager: manager(),
    } as unknown as UpdateEvent<Order>);
    expect(insert).toHaveBeenLastCalledWith(
      OrderStatusHistory,
      expect.objectContaining({ reason: 'Pidió otra cosa' }),
    );

    const entregado = pedido({
      status: OrderStatus.DELIVERED,
      transitionReason: 'Sin celular, confirmó por teléfono',
    });
    await subscriber.afterUpdate({
      entity: entregado,
      databaseEntity: pedido({ status: OrderStatus.ON_THE_WAY }),
      manager: manager(),
    } as unknown as UpdateEvent<Order>);
    expect(insert).toHaveBeenLastCalledWith(
      OrderStatusHistory,
      expect.objectContaining({ reason: 'Sin celular, confirmó por teléfono' }),
    );
    expect(entregado.transitionReason).toBeUndefined();
  });
});
