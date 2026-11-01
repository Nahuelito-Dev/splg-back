import type { DataSource } from 'typeorm';
import { CustomerPurchaseStatsService } from './customer-purchase-stats.service';

describe('CustomerPurchaseStatsService', () => {
  const query = jest.fn();
  const service = new CustomerPurchaseStatsService({
    query,
  } as unknown as DataSource);

  beforeEach(() => query.mockReset());

  it('arma el resumen con lo que calcula la base, acotado al cliente y a la distribuidora', async () => {
    query.mockResolvedValue([
      {
        total_purchased: '184500.50',
        orders_count: 12,
        delivered_count: 9,
        average_ticket: '20500.06',
        last_delivered_at: new Date('2026-10-30T15:00:00Z'),
      },
    ]);
    const r = await service.estadisticas('u1', 'd1');
    expect(r).toEqual({
      totalPurchased: 184500.5,
      ordersCount: 12,
      deliveredCount: 9,
      averageTicket: 20500.06,
      lastDeliveredAt: new Date('2026-10-30T15:00:00Z'),
    });
    const [sql, params] = query.mock.calls[0] as [string, string[]];
    expect(params).toEqual(['u1', 'd1']);
    expect(sql).toContain('"distributor_id" = $2');
    expect(sql).toContain(`FILTER (WHERE "status" = 'delivered')`);
  });

  it('sin entregas no hay ticket promedio ni última compra, y no se inventa', async () => {
    query.mockResolvedValue([
      {
        total_purchased: '0',
        orders_count: 2,
        delivered_count: 0,
        average_ticket: null,
        last_delivered_at: null,
      },
    ]);
    const r = await service.estadisticas('u1', 'd1');
    expect(r).toMatchObject({
      totalPurchased: 0,
      ordersCount: 2,
      averageTicket: null,
      lastDeliveredAt: null,
    });
  });
});
