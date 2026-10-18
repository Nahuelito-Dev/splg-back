import { EntityManager, In, Repository } from 'typeorm';
import { OrderLookupService } from './order-lookup.service';
import { Order, OrderStatus } from '../entities/order.entity';

describe('OrderLookupService.countActiveByCustomer', () => {
  let repo: { count: jest.Mock };
  let service: OrderLookupService;

  beforeEach(() => {
    repo = { count: jest.fn().mockResolvedValue(2) };
    service = new OrderLookupService(repo as unknown as Repository<Order>);
  });

  it('cuenta los cuatro estados abiertos del cliente, sin filtrar por distribuidora', async () => {
    await expect(service.countActiveByCustomer('u1')).resolves.toBe(2);
    expect(repo.count).toHaveBeenCalledWith({
      where: {
        customerId: 'u1',
        status: In([
          OrderStatus.RESERVED,
          OrderStatus.PENDING,
          OrderStatus.ACCEPTED,
          OrderStatus.ON_THE_WAY,
        ]),
      },
    });
  });

  it('dentro de una transacción cuenta con su manager', async () => {
    const manager = { count: jest.fn().mockResolvedValue(1) };
    await service.countActiveByCustomer(
      'u1',
      manager as unknown as EntityManager,
    );
    expect(manager.count).toHaveBeenCalledWith(Order, expect.anything());
    expect(repo.count).not.toHaveBeenCalled();
  });
});

describe('OrderLookupService.ultimaCompraEntregada', () => {
  const entregado = new Date('2026-09-01T00:00:00.000Z');
  let ordenes: { findOne: jest.Mock };
  let renglones: { find: jest.Mock };
  let service: OrderLookupService;

  beforeEach(() => {
    ordenes = { findOne: jest.fn() };
    renglones = { find: jest.fn() };
    const manager = {
      getRepository: (e: unknown) => (e === Order ? ordenes : renglones),
    };
    service = new OrderLookupService({
      manager,
    } as unknown as Repository<Order>);
  });

  it('sin pedidos entregados devuelve null', async () => {
    ordenes.findOne.mockResolvedValue(null);
    await expect(service.ultimaCompraEntregada('u1')).resolves.toBeNull();
    expect(renglones.find).not.toHaveBeenCalled();
  });

  it('suma los kilos con aritmética decimal exacta', async () => {
    ordenes.findOne.mockResolvedValue({
      orderId: 'o1',
      deliveredAt: entregado,
    });
    renglones.find.mockResolvedValue([
      { quantity: 3, gasCylinder: { weight: 0.1 } },
      { quantity: 1, gasCylinder: { weight: 0.2 } },
    ]);

    const r = await service.ultimaCompraEntregada('u1');

    expect(r?.kg).toBe(0.5);
  });

  it('busca el último entregado del cliente y suma los kilos de sus renglones', async () => {
    ordenes.findOne.mockResolvedValue({
      orderId: 'o1',
      deliveredAt: entregado,
    });
    renglones.find.mockResolvedValue([
      { quantity: 2, gasCylinder: { weight: 10 } },
      { quantity: 1, gasCylinder: { weight: 45 } },
    ]);

    await expect(service.ultimaCompraEntregada('u1')).resolves.toEqual({
      deliveredAt: entregado,
      kg: 65,
    });
    expect(ordenes.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customerId: 'u1', status: OrderStatus.DELIVERED },
      }),
    );
  });
});
