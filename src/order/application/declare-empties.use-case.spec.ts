import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { DeclareEmptiesUseCase } from './declare-empties.use-case';
import { Order, OrderStatus } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';

describe('DeclareEmptiesUseCase', () => {
  const order = {
    orderId: 'order-1',
    distributorId: 'dist-1',
    deliveryId: 'delivery-1',
    status: OrderStatus.ON_THE_WAY,
  } as Order;
  const item = {
    orderId: order.orderId,
    gasCylinderId: 'cylinder-1',
    quantity: 3,
    containersCharged: 1,
    emptiesReceived: null,
  } as OrderItem;
  let locked: Order | null;
  let items: OrderItem[];
  let save: jest.Mock;
  let driver: { deliveryId: string } | null;
  let complete: Order | null;
  let useCase: DeclareEmptiesUseCase;

  beforeEach(() => {
    locked = { ...order };
    items = [{ ...item }];
    save = jest.fn().mockResolvedValue(undefined);
    driver = { deliveryId: 'delivery-1' };
    complete = { ...order, items };
    const manager = {
      createQueryBuilder: jest.fn(() => {
        const query = {
          setLock: jest.fn(),
          where: jest.fn(),
          getOne: jest.fn(() => Promise.resolve(locked)),
        };
        query.setLock.mockReturnValue(query);
        query.where.mockReturnValue(query);
        return query;
      }),
      find: jest.fn(() => Promise.resolve(items)),
      save,
    };
    const dataSource = {
      transaction: jest.fn((work: (m: typeof manager) => Promise<void>) =>
        work(manager),
      ),
    };
    const deliveries = {
      buscarPorIdOUsuario: jest.fn(() => Promise.resolve(driver)),
    };
    const orders = { findByIdFull: jest.fn(() => Promise.resolve(complete)) };
    useCase = new DeclareEmptiesUseCase(
      dataSource as never,
      deliveries as never,
      orders as never,
    );
  });

  const execute = (emptiesReceived = 1, gasCylinderId = 'cylinder-1') =>
    useCase.execute(order.orderId, 'driver-1', 'dist-1', {
      items: [{ gasCylinderId, emptiesReceived }],
    });

  it('acepta el rango, persiste y devuelve el pedido completo', async () => {
    await expect(execute(2)).resolves.toBe(complete);
    expect(items[0].emptiesReceived).toBe(2);
    expect(save).toHaveBeenCalledWith(items);
  });

  it('rechaza una cantidad fuera de rango', async () => {
    await expect(execute(3)).rejects.toThrow(BadRequestException);
    expect(save).not.toHaveBeenCalled();
  });

  it('rechaza un tipo que no pertenece al pedido', async () => {
    await expect(execute(1, 'cylinder-other')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rechaza a otro chofer', async () => {
    driver = { deliveryId: 'delivery-other' };
    await expect(execute()).rejects.toThrow(ForbiddenException);
  });

  it('rechaza un pedido que no está en camino', async () => {
    locked = { ...order, status: OrderStatus.PENDING };
    await expect(execute()).rejects.toThrow(ConflictException);
  });

  it('es idempotente: repetir la misma declaración conserva el valor', async () => {
    await execute(1);
    await execute(1);
    expect(items[0].emptiesReceived).toBe(1);
    expect(save).toHaveBeenCalledTimes(2);
  });
});
