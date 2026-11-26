import { Repository } from 'typeorm';
import { Order } from '../order/entities/order.entity';
import { OrderItem } from '../order/entities/order-item.entity';
import { ReportsService } from './reports.service';
import { FleetCostService } from '../fleet-expense/fleet-cost.service';
import { EntityPhotoService } from '../s3/entity-photo.service';

const costService = {} as FleetCostService;
const photoService = {} as EntityPhotoService;

/** Los totales, el resumen, los impagos y el día a día del chofer salen del back. */
describe('ReportsService — cuentas de plata del panel y de la app del chofer', () => {
  let service: ReportsService;
  let qb: Record<string, jest.Mock>;

  beforeEach(() => {
    qb = {};
    for (const m of [
      'select',
      'addSelect',
      'where',
      'andWhere',
      'innerJoin',
      'withDeleted',
      'groupBy',
      'addGroupBy',
      'innerJoinAndSelect',
      'orderBy',
    ]) {
      qb[m] = jest.fn(() => qb);
    }
    qb.getRawMany = jest.fn();
    const orders = { createQueryBuilder: jest.fn(() => qb) };
    service = new ReportsService(
      orders as unknown as Repository<Order>,
      {} as Repository<OrderItem>,
      costService,
      photoService,
    );
  });

  it('los totales por medio de pago suman las filas y las ordenan de mayor a menor', async () => {
    qb.getRawMany.mockResolvedValue([
      { method: 'cash', count: '2', total: '0.10' },
      { method: 'transfer', count: '1', total: '0.20' },
    ]);
    const r = await service.getSalesByPaymentMethodConTotales(
      new Date(),
      new Date(),
    );
    expect(r.rows.map((f) => f.method)).toEqual(['transfer', 'cash']);
    expect(r.totals).toEqual({ totalOrders: 3, totalSales: 0.3 });
  });

  it('los totales por chofer se ordenan de mayor a menor venta y se suman', async () => {
    const choferes = [
      { userId: 'u1', user: { fullName: 'Ana' }, total: 100 },
      { userId: 'u2', user: { fullName: 'Beto' }, total: 300.25 },
    ];
    const ordersConChoferes = {
      find: jest.fn().mockResolvedValue(
        choferes.map((c) => ({
          delivery: { userId: c.userId, user: c.user },
          totalAmount: c.total,
          paymentStatus: 'paid',
        })),
      ),
    };
    const svc = new ReportsService(
      ordersConChoferes as unknown as Repository<Order>,
      {} as Repository<OrderItem>,
      costService,
      photoService,
    );
    const r = await svc.getSalesByDriverConTotales(new Date(), new Date());
    expect(r.rows.map((f) => f.driverName)).toEqual(['Beto', 'Ana']);
    expect(r.totals).toEqual({ totalOrders: 2, totalSales: 400.25 });
  });

  it('a igual venta desempata por nombre aunque falte el del chofer o la descripción del producto', async () => {
    const orders = {
      find: jest.fn().mockResolvedValue([
        {
          delivery: { userId: 'u2', user: { fullName: 'Zoe' } },
          totalAmount: 10,
          paymentStatus: 'paid',
        },
        {
          delivery: { userId: 'u1', user: { fullName: undefined } },
          totalAmount: 10,
          paymentStatus: 'paid',
        },
      ]),
    };
    const svc = new ReportsService(
      orders as unknown as Repository<Order>,
      {} as Repository<OrderItem>,
      costService,
      photoService,
    );
    const r = await svc.getSalesByDriverConTotales(new Date(), new Date());
    expect(r.rows.map((f) => f.driverId)).toEqual(['u1', 'u2']);
    qb.innerJoinAndSelect = jest.fn(() => qb);
    qb.getRawMany.mockResolvedValue([
      {
        productType: '10kg',
        description: null,
        totalQuantity: '1',
        totalSales: '5',
      },
      {
        productType: '10kg',
        description: 'b',
        totalQuantity: '1',
        totalSales: '5',
      },
    ]);
    const p = await service.getSalesByProductConTotales(new Date(), new Date());
    expect(p.rows.map((f) => f.description)).toEqual([null, 'b']);
  });

  it('el resumen sin filas es todo cero', async () => {
    qb.getRawMany.mockResolvedValue([]);
    expect(await service.getSalesSummary(new Date(), new Date())).toEqual({
      totalSales: 0,
      totalOrders: 0,
      averageTicket: 0,
    });
    expect(await service.getUnpaidTotal()).toEqual({
      totalOrders: 0,
      totalAmount: 0,
    });
  });

  it('los totales por producto suman unidades y ventas', async () => {
    qb.getRawMany.mockResolvedValue([
      {
        productType: '10kg',
        description: null,
        totalQuantity: '2',
        totalSales: '100',
      },
      {
        productType: '15kg',
        description: null,
        totalQuantity: '3',
        totalSales: '250.5',
      },
    ]);
    const r = await service.getSalesByProductConTotales(new Date(), new Date());
    expect(r.rows[0].productType).toBe('15kg');
    expect(r.totals).toEqual({ totalQuantity: 5, totalSales: 350.5 });
  });

  it('el resumen calcula el ticket promedio y da 0 sin pedidos', async () => {
    qb.getRawMany.mockResolvedValueOnce([{ count: '3', total: '100' }]);
    expect(await service.getSalesSummary(new Date(), new Date())).toEqual({
      totalSales: 100,
      totalOrders: 3,
      averageTicket: 33.33,
    });
    qb.getRawMany.mockResolvedValueOnce([{ count: '0', total: '0' }]);
    expect(
      (await service.getSalesSummary(new Date(), new Date())).averageTicket,
    ).toBe(0);
  });

  it('el total de impagos filtra por estado impago y por distribuidora', async () => {
    qb.getRawMany.mockResolvedValue([{ count: '2', total: '1500.50' }]);
    expect(await service.getUnpaidTotal('d1')).toEqual({
      totalOrders: 2,
      totalAmount: 1500.5,
    });
    expect(qb.where).toHaveBeenCalledWith('order.paymentStatus = :unpaid', {
      unpaid: 'unpaid',
    });
    expect(qb.andWhere).toHaveBeenCalledWith(
      'order.distributorId = :distributorId',
      { distributorId: 'd1' },
    );
  });

  it('el día a día del chofer descuenta la seña paga, es del chofer y de su distribuidora', async () => {
    // 2026-10-30 00:00 en Argentina
    qb.getRawMany.mockResolvedValue([
      { period: new Date('2026-10-30T03:00:00Z'), count: '2', total: '3500' },
    ]);
    const r = await service.getDriverDailyTotals(
      'u1',
      new Date(),
      new Date(),
      'd1',
    );
    expect(r).toEqual([
      { day: '2026-10-30', deliveredOrders: 2, totalAmount: 3500 },
    ]);
    const sumas = qb.addSelect.mock.calls.map(([e]: [string]) => e).join(' ');
    expect(sumas).toContain('order.depositPaid');
    expect(qb.andWhere).toHaveBeenCalledWith(
      'delivery.userId = :driverUserId',
      {
        driverUserId: 'u1',
      },
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      'order.distributorId = :distributorId',
      { distributorId: 'd1' },
    );
  });
});
