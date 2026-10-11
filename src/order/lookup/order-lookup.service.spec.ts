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
