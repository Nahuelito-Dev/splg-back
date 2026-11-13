import { DataSource, UpdateEvent } from 'typeorm';
import { Order, OrderStatus } from '../../order/entities/order.entity';
import { RouteSheetStopReleaseSubscriber } from './route-sheet-stop-release.subscriber';

describe('RouteSheetStopReleaseSubscriber', () => {
  const armar = () => {
    const ds = { subscribers: [] as unknown[] };
    const sub = new RouteSheetStopReleaseSubscriber(
      ds as unknown as DataSource,
    );
    const query = jest.fn().mockResolvedValue([]);
    const evento = (antes: OrderStatus | null, despues: OrderStatus | null) =>
      ({
        entity: despues ? { orderId: 'o1', status: despues } : undefined,
        databaseEntity: antes ? { orderId: 'o1', status: antes } : undefined,
        manager: { query },
      }) as unknown as UpdateEvent<Order>;
    return { ds, sub, query, evento };
  };

  it('se registra en el DataSource y escucha los pedidos', () => {
    const { ds, sub } = armar();
    expect(ds.subscribers).toContain(sub);
    expect(sub.listenTo()).toBe(Order);
  });

  it.each([
    [OrderStatus.CANCELLED, 'cancelled'],
    [OrderStatus.DELIVERED, 'unavailable'],
  ])(
    'al pasar a %s saca la parada de la hoja viva, en la misma transacción',
    async (estado, motivo) => {
      const { sub, query, evento } = armar();
      await sub.afterUpdate(evento(OrderStatus.PENDING, estado));
      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual(['o1', motivo]);
      expect(sql).toContain(
        `b."kind" = 'planned' AND b."status" IN ('draft', 'confirmed')`,
      );
      expect(sql).toContain('"active" = false');
    },
  );

  it('otros cambios (o sin cambio de estado) no tocan las paradas', async () => {
    const { sub, query, evento } = armar();
    await sub.afterUpdate(evento(OrderStatus.RESERVED, OrderStatus.PENDING));
    await sub.afterUpdate(evento(OrderStatus.CANCELLED, OrderStatus.CANCELLED));
    await sub.afterUpdate(evento(null, OrderStatus.CANCELLED));
    await sub.afterUpdate(evento(OrderStatus.PENDING, null));
    expect(query).not.toHaveBeenCalled();
  });
});
