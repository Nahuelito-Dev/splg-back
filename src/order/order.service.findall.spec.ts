import { BadRequestException } from '@nestjs/common';
import { OrderService } from './order.service';

describe('OrderService.findAll — rango de fechas', () => {
  let findAllPaginated: jest.Mock;
  let service: OrderService;

  beforeEach(() => {
    findAllPaginated = jest.fn().mockResolvedValue([[], 0]);
    service = Object.assign(Object.create(OrderService.prototype), {
      orders: { findAllPaginated },
    }) as OrderService;
  });

  it('rechaza from posterior a to con 400, igual que los reportes', async () => {
    await expect(
      service.findAll({ from: '2026-09-10', to: '2026-09-01' }, 'd1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findAllPaginated).not.toHaveBeenCalled();
  });

  it('acepta un rango de un solo día', async () => {
    await service.findAll({ from: '2026-09-15', to: '2026-09-15' }, 'd1');
    expect(findAllPaginated).toHaveBeenCalledWith(10, 0, 'd1', {
      term: undefined,
      status: undefined,
      from: '2026-09-15',
      to: '2026-09-15',
    });
  });

  it('rechaza deliveredFrom posterior a deliveredTo con 400', async () => {
    await expect(
      service.findAll(
        { deliveredFrom: '2026-09-10', deliveredTo: '2026-09-01' },
        'd1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findAllPaginated).not.toHaveBeenCalled();
  });

  it('pasa la fecha de entrega y el orden al repositorio', async () => {
    await service.findAll(
      {
        deliveredFrom: '2026-09-15',
        deliveredTo: '2026-09-15',
        sort: 'deliveredAt',
        order: 'asc',
      },
      'd1',
    );
    expect(findAllPaginated).toHaveBeenCalledWith(
      10,
      0,
      'd1',
      expect.objectContaining({
        deliveredFrom: '2026-09-15',
        deliveredTo: '2026-09-15',
        sort: 'deliveredAt',
        order: 'asc',
      }),
    );
  });
});
