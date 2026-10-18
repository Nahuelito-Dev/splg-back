import { RefundsController } from './refunds.controller';
import { RefundKind, RefundStatus } from '../domain/payment.enums';
import { PaymentRefund } from '../entities/payment-refund.entity';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

const fila = (over: Partial<PaymentRefund> = {}): PaymentRefund =>
  ({
    refundId: 'ref-1',
    orderId: 'ord-1',
    paymentId: 'pay-1',
    kind: RefundKind.FULL,
    amount: 3000,
    status: RefundStatus.FAILED,
    gatewayRefundId: null,
    errorMessage: 'caída',
    attempts: 1,
    refundedAt: null,
    createdAt: new Date('2026-10-17T10:00:00Z'),
    updatedAt: new Date('2026-10-17T10:00:00Z'),
    ...over,
  }) as PaymentRefund;

describe('RefundsController', () => {
  let refunds: {
    listar: jest.Mock;
    listarDelPedido: jest.Mock;
    reintentar: jest.Mock;
  };
  let controller: RefundsController;

  beforeEach(() => {
    refunds = {
      listar: jest.fn().mockResolvedValue({ items: [fila()], total: 1 }),
      listarDelPedido: jest.fn().mockResolvedValue([fila()]),
      reintentar: jest
        .fn()
        .mockResolvedValue([fila({ status: RefundStatus.SUCCEEDED })]),
    };
    controller = new RefundsController(refunds as never);
  });

  it('GET /refunds pasa el estado y la paginación y arma el DTO', async () => {
    const r = await controller.listar(
      { status: RefundStatus.FAILED, limit: 5, offset: 10 },
      'dist-1',
    );

    expect(refunds.listar).toHaveBeenCalledWith('dist-1', {
      status: RefundStatus.FAILED,
      limit: 5,
      offset: 10,
    });
    expect(r).toMatchObject({ total: 1, limit: 5, offset: 10 });
    expect(r.items[0]).toMatchObject({
      refundId: 'ref-1',
      status: 'failed',
      errorMessage: 'caída',
    });
  });

  it('GET /refunds usa 10 y 0 por omisión', async () => {
    const r = await controller.listar({}, 'dist-1');
    expect(refunds.listar).toHaveBeenCalledWith('dist-1', {
      status: undefined,
      limit: 10,
      offset: 0,
    });
    expect(r.limit).toBe(10);
  });

  it('GET /orders/:id/refunds acota por la distribuidora', async () => {
    const r = await controller.delPedido('ord-1', 'dist-1');
    expect(refunds.listarDelPedido).toHaveBeenCalledWith('ord-1', 'dist-1');
    expect(r).toHaveLength(1);
  });

  it('POST /orders/:id/refunds/retry reintenta con el usuario del token', async () => {
    const r = await controller.reintentar('ord-1', 'dist-1', {
      user_id: 'adm-1',
    } as AuthenticatedUser);
    expect(refunds.reintentar).toHaveBeenCalledWith('ord-1', 'dist-1', 'adm-1');
    expect(r[0].status).toBe('succeeded');
  });
});
