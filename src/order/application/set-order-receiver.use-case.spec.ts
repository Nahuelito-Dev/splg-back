import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  MENSAJE_RECEPTOR_CANCELADO,
  MENSAJE_RECEPTOR_ENTREGADO,
  SetOrderReceiverUseCase,
} from './set-order-receiver.use-case';
import { Order, OrderStatus } from '../entities/order.entity';

describe('SetOrderReceiverUseCase (CU-128)', () => {
  let useCase: SetOrderReceiverUseCase;
  let locked: Order | null;
  let save: jest.Mock;

  const dto = {
    receiverName: 'María Gómez',
    receiverDocument: '30123456',
    receiverRelationship: 'vecina',
  };

  const makeOrder = (over: Partial<Order> = {}): Order =>
    ({
      orderId: 'o1',
      customerId: 'c1',
      distributorId: 'd1',
      status: OrderStatus.PENDING,
      receiverName: null,
      receiverDocument: null,
      receiverRelationship: null,
      ...over,
    }) as unknown as Order;

  beforeEach(() => {
    locked = makeOrder();
    save = jest.fn((o: unknown) => Promise.resolve(o));
    const qb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(() => Promise.resolve(locked)),
    };
    useCase = new SetOrderReceiverUseCase({
      transaction: jest.fn((fn: (m: unknown) => unknown) =>
        fn({ createQueryBuilder: () => qb, save }),
      ),
    } as unknown as DataSource);
  });

  it.each([OrderStatus.PENDING, OrderStatus.ACCEPTED, OrderStatus.ON_THE_WAY])(
    'un pedido %s guarda nombre, documento y relación',
    async (status) => {
      locked = makeOrder({ status });
      await expect(useCase.execute('o1', dto, 'c1', 'd1')).resolves.toBe('o1');
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          receiverName: 'María Gómez',
          receiverDocument: '30123456',
          receiverRelationship: 'vecina',
        }),
      );
    },
  );

  it('un pedido entregado se rechaza (409) y no escribe', async () => {
    locked = makeOrder({ status: OrderStatus.DELIVERED });
    await expect(useCase.execute('o1', dto, 'c1', 'd1')).rejects.toThrow(
      new ConflictException(MENSAJE_RECEPTOR_ENTREGADO),
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('un pedido cancelado también se rechaza (409)', async () => {
    locked = makeOrder({ status: OrderStatus.CANCELLED });
    await expect(useCase.execute('o1', dto, 'c1', 'd1')).rejects.toThrow(
      new ConflictException(MENSAJE_RECEPTOR_CANCELADO),
    );
  });

  it('un pedido de otro cliente, de otra distribuidora o inexistente es 404', async () => {
    locked = makeOrder({ customerId: 'otro' });
    await expect(useCase.execute('o1', dto, 'c1', 'd1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    locked = makeOrder();
    await expect(
      useCase.execute('o1', dto, 'c1', 'otra'),
    ).rejects.toBeInstanceOf(NotFoundException);
    locked = null;
    await expect(useCase.execute('o1', dto, 'c1', 'd1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('sin distribuidora en contexto (cliente sin X-Distributor) alcanza con ser el dueño', async () => {
    await expect(useCase.execute('o1', dto, 'c1', null)).resolves.toBe('o1');
  });
});
