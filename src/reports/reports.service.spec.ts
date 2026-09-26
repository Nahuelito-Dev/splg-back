import { Repository } from 'typeorm';
import { ReportsService } from './reports.service';
import { Order } from '../order/entities/order.entity';
import { OrderItem } from '../order/entities/order-item.entity';

/**
 * Los informes agregan pedidos entregados. Lo que se prueba acá es la cuenta:
 * que las ventas se sumen con precisión decimal y que las filas crudas de
 * Postgres se conviertan a números.
 */
describe('ReportsService', () => {
  let service: ReportsService;
  let orders: { find: jest.Mock; createQueryBuilder: jest.Mock };

  interface QbFalso {
    select: jest.Mock;
    addSelect: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    groupBy: jest.Mock;
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
      { delivery: chofer, totalAmount: 0.1 },
      { delivery: chofer, totalAmount: 0.2 },
      { delivery: null, totalAmount: 99 },
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
});
