import { Repository } from 'typeorm';
import { ReportsService } from './reports.service';
import {
  Order,
  PaymentMethod,
  PaymentStatus,
} from '../order/entities/order.entity';
import { OrderItem } from '../order/entities/order-item.entity';

/**
 * Los informes agregan pedidos entregados. Lo que se prueba acá es la cuenta:
 * que las ventas se sumen con precisión decimal y que las filas crudas de
 * Postgres se conviertan a números.
 */
const COBRADO = {
  paymentStatus: PaymentStatus.PAID,
  paymentMethod: PaymentMethod.CASH,
};

describe('ReportsService', () => {
  let service: ReportsService;
  let orders: { find: jest.Mock; createQueryBuilder: jest.Mock };

  interface QbFalso {
    select: jest.Mock;
    addSelect: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    groupBy: jest.Mock;
    orderBy: jest.Mock;
    getRawMany: jest.Mock;
  }
  let qb: QbFalso;

  beforeEach(() => {
    qb = {
      select: jest.fn((): QbFalso => qb),
      addSelect: jest.fn((): QbFalso => qb),
      where: jest.fn((): QbFalso => qb),
      andWhere: jest.fn((): QbFalso => qb),
      groupBy: jest.fn((): QbFalso => qb),
      orderBy: jest.fn((): QbFalso => qb),
      getRawMany: jest.fn(),
    };
    orders = { find: jest.fn(), createQueryBuilder: jest.fn(() => qb) };
    service = new ReportsService(
      orders as unknown as Repository<Order>,
      {} as Repository<OrderItem>,
    );
  });

  it('suma las ventas de cada chofer sin errores de redondeo', async () => {
    const chofer = { userId: 'u1', user: { fullName: 'Juan' } };
    orders.find.mockResolvedValue([
      { delivery: chofer, totalAmount: 0.1, ...COBRADO },
      { delivery: chofer, totalAmount: 0.2, ...COBRADO },
      { delivery: null, totalAmount: 99, ...COBRADO },
    ]);
    const r = await service.getSalesByDriver(new Date(), new Date());
    expect(r).toEqual([
      { driverId: 'u1', driverName: 'Juan', totalOrders: 2, totalSales: 0.3 },
    ]);
  });

  it('filtra por distribuidora sólo si viene una', async () => {
    orders.find.mockResolvedValue([]);
    await service.getSalesByDriver(new Date(), new Date(), 'd1');
    expect(orders.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ distributorId: 'd1' }) as unknown,
      }),
    );
  });

  it('convierte las filas del medio de pago a números', async () => {
    qb.getRawMany.mockResolvedValue([
      { method: 'cash', count: '3', total: '4500.50' },
    ]);
    const r = await service.getSalesByPaymentMethod(new Date(), new Date());
    expect(r).toEqual([{ method: 'cash', totalOrders: 3, totalSales: 4500.5 }]);
  });

  it('el informe por producto lee los alias tal como los pidió (H-56)', async () => {
    interface QbProducto {
      innerJoinAndSelect: jest.Mock;
      where: jest.Mock;
      andWhere: jest.Mock;
      select: jest.Mock;
      addSelect: jest.Mock;
      groupBy: jest.Mock;
      addGroupBy: jest.Mock;
      getRawMany: jest.Mock;
    }
    const qbProducto: QbProducto = {
      innerJoinAndSelect: jest.fn((): QbProducto => qbProducto),
      where: jest.fn((): QbProducto => qbProducto),
      andWhere: jest.fn((): QbProducto => qbProducto),
      select: jest.fn((): QbProducto => qbProducto),
      addSelect: jest.fn((): QbProducto => qbProducto),
      groupBy: jest.fn((): QbProducto => qbProducto),
      addGroupBy: jest.fn((): QbProducto => qbProducto),
      getRawMany: jest.fn().mockResolvedValue([
        {
          productType: 'Garrafa 10kg',
          description: '10 kg',
          totalQuantity: '182',
          totalSales: '2711800.00',
        },
      ]),
    };
    orders.createQueryBuilder.mockReturnValue(qbProducto);
    const r = await service.getSalesByProduct(new Date(), new Date());
    expect(qbProducto.select).toHaveBeenCalledWith(
      'product.type',
      'productType',
    );
    expect(r).toEqual([
      {
        productType: 'Garrafa 10kg',
        description: '10 kg',
        totalQuantity: 182,
        totalSales: 2711800,
      },
    ]);
  });

  describe('getSalesEvolution', () => {
    it('granularity=week agrupa por semana ISO, no por día (H-57)', async () => {
      qb.getRawMany.mockResolvedValue([]);
      await service.getSalesEvolution(new Date(), new Date(), 'week');
      expect(qb.select).toHaveBeenCalledWith(
        `date_trunc('week', order.deliveredAt AT TIME ZONE 'America/Argentina/Buenos_Aires') AT TIME ZONE 'America/Argentina/Buenos_Aires'`,
        'period',
      );
    });

    it('granularity=day agrupa por día', async () => {
      qb.getRawMany.mockResolvedValue([]);
      await service.getSalesEvolution(new Date(), new Date(), 'day');
      expect(qb.select).toHaveBeenCalledWith(
        `date_trunc('day', order.deliveredAt AT TIME ZONE 'America/Argentina/Buenos_Aires') AT TIME ZONE 'America/Argentina/Buenos_Aires'`,
        'period',
      );
    });

    it('granularity=month agrupa por mes', async () => {
      qb.getRawMany.mockResolvedValue([]);
      await service.getSalesEvolution(new Date(), new Date(), 'month');
      expect(qb.select).toHaveBeenCalledWith(
        `date_trunc('month', order.deliveredAt AT TIME ZONE 'America/Argentina/Buenos_Aires') AT TIME ZONE 'America/Argentina/Buenos_Aires'`,
        'period',
      );
    });
  });

  it('el rango es [start, end): el fin es exclusivo, no BETWEEN', async () => {
    qb.getRawMany.mockResolvedValue([]);
    const start = new Date('2026-07-07T03:00:00Z');
    const end = new Date('2026-07-08T03:00:00Z');
    await service.getSalesByPaymentMethod(start, end);
    expect(qb.andWhere).toHaveBeenCalledWith(
      'order.deliveredAt >= :start AND order.deliveredAt < :end',
      { start, end },
    );
  });

  describe('ventas = entregado y cobrado', () => {
    it('por chofer sólo cuenta lo pagado: ni efectivo pendiente, ni transferencia pendiente, ni impago, ni pérdida', async () => {
      const chofer = { userId: 'u1', user: { fullName: 'Juan' } };
      const p = (
        paymentStatus: PaymentStatus,
        paymentMethod: PaymentMethod,
        totalAmount: number,
      ) => ({ delivery: chofer, totalAmount, paymentStatus, paymentMethod });
      orders.find.mockResolvedValue([
        p(PaymentStatus.PAID, PaymentMethod.CASH, 100),
        p(PaymentStatus.PENDING, PaymentMethod.TRANSFER, 10),
        p(PaymentStatus.PENDING, PaymentMethod.CASH, 1000),
        p(PaymentStatus.UNPAID, PaymentMethod.CASH, 2000),
        p(PaymentStatus.WRITTEN_OFF, PaymentMethod.CASH, 4000),
      ]);
      const r = await service.getSalesByDriver(new Date(), new Date());
      expect(r).toEqual([
        { driverId: 'u1', driverName: 'Juan', totalOrders: 1, totalSales: 100 },
      ]);
    });

    it.each([
      [
        'por medio de pago',
        (s: ReportsService) =>
          s.getSalesByPaymentMethod(new Date(), new Date()),
      ],
      [
        'por producto',
        (s: ReportsService) => s.getSalesByProduct(new Date(), new Date()),
      ],
      [
        'evolución',
        (s: ReportsService) =>
          s.getSalesEvolution(new Date(), new Date(), 'day'),
      ],
    ])('%s filtra por cobrado en la consulta', async (_n, llamar) => {
      qb.getRawMany.mockResolvedValue([]);
      const extra = qb as unknown as Record<string, jest.Mock>;
      extra.innerJoinAndSelect = jest.fn(() => qb);
      extra.addGroupBy = jest.fn(() => qb);
      orders.createQueryBuilder.mockReturnValue(qb);
      await llamar(service);
      const filtroDeCobro = qb.andWhere.mock.calls.some(
        ([arg, params]: [unknown, unknown]) =>
          typeof arg === 'string' &&
          arg.endsWith('.paymentStatus = :vcPaid') &&
          (params as { vcPaid?: string }).vcPaid === 'paid',
      );
      expect(filtroDeCobro).toBe(true);
    });
  });

  describe('getCollections', () => {
    it('separa efectivo pendiente, impagos y pérdidas, y arma 0 lo que no hay', async () => {
      qb.getRawMany.mockResolvedValue([
        { status: 'pending', count: '3', total: '30000.5' },
        { status: 'unpaid', count: '1', total: '9500' },
      ]);
      const r = await service.getCollections(new Date(), new Date(), 'd1');
      expect(r).toEqual({
        pendingCash: { totalOrders: 3, totalAmount: 30000.5 },
        unpaid: { totalOrders: 1, totalAmount: 9500 },
        writtenOff: { totalOrders: 0, totalAmount: 0 },
      });
      expect(qb.andWhere).toHaveBeenCalledWith(
        'order.distributorId = :distributorId',
        { distributorId: 'd1' },
      );
    });
  });
});
