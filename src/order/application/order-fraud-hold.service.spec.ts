import { ConflictException, NotFoundException } from '@nestjs/common';
import { OrderFraudHoldService } from './order-fraud-hold.service';

describe('OrderFraudHoldService (M-1)', () => {
  let pedido: Record<string, unknown> | null;
  let save: jest.Mock;
  let where: jest.Mock;
  let service: OrderFraudHoldService;

  beforeEach(() => {
    pedido = { orderId: 'o1', paymentFraudHold: true };
    save = jest.fn((x: unknown) => Promise.resolve(x));
    const qb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn(() => Promise.resolve(pedido)),
    };
    where = qb.andWhere;
    const manager = { createQueryBuilder: () => qb, save };
    service = new OrderFraudHoldService({
      transaction: (f: (m: unknown) => unknown) => f(manager),
    } as never);
  });

  it('libera la retención y deja quién, cuándo y el motivo (sin espacios de más)', async () => {
    await expect(
      service.liberar('o1', 'd1', 'u1', '  Verifiqué el pago con el cliente  '),
    ).resolves.toEqual({ orderId: 'o1', paymentFraudHold: false });

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentFraudHold: false,
        paymentFraudReleasedBy: 'u1',
        paymentFraudReleasedReason: 'Verifiqué el pago con el cliente',
        paymentFraudReleasedAt: expect.any(Date) as Date,
      }),
    );
  });

  it('lee el pedido bloqueado y dentro de la distribuidora', async () => {
    await service.liberar('o1', 'd1', 'u1', 'motivo suficiente');
    expect(where).toHaveBeenCalledWith('order.distributorId = :distributorId', {
      distributorId: 'd1',
    });
  });

  it('un pedido que no está retenido responde 409 y no guarda nada', async () => {
    pedido = { orderId: 'o1', paymentFraudHold: false };
    await expect(
      service.liberar('o1', 'd1', 'u1', 'motivo suficiente'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(save).not.toHaveBeenCalled();
  });

  it('un pedido de otra distribuidora o inexistente es 404', async () => {
    pedido = null;
    await expect(
      service.liberar('o1', 'd1', 'u1', 'motivo suficiente'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
