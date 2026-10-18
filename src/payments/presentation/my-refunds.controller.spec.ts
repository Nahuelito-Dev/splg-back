import { MyRefundsController } from './my-refunds.controller';
import { RefundKind, RefundStatus } from '../domain/payment.enums';
import { PaymentRefund } from '../entities/payment-refund.entity';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

describe('MyRefundsController', () => {
  it('devuelve sólo lo que ve el cliente: sin ids de pasarela, intentos ni texto de error', async () => {
    const creada = new Date('2026-10-17T10:00:00Z');
    const acreditada = new Date('2026-10-17T10:05:00Z');
    const refunds = {
      listarDelCliente: jest.fn().mockResolvedValue([
        {
          refundId: 'ref-1',
          orderId: 'ord-1',
          paymentId: 'pay-1',
          kind: RefundKind.FULL,
          amount: 3000,
          status: RefundStatus.SUCCEEDED,
          gatewayRefundId: 'mp-9',
          errorMessage: 'interno',
          attempts: 2,
          refundedAt: acreditada,
          createdAt: creada,
          updatedAt: acreditada,
        } as PaymentRefund,
      ]),
    };
    const controller = new MyRefundsController(refunds as never);

    const r = await controller.delPedido('ord-1', {
      user_id: 'cus-1',
    } as AuthenticatedUser);

    expect(refunds.listarDelCliente).toHaveBeenCalledWith('ord-1', 'cus-1');
    expect(r).toEqual([
      {
        kind: 'full',
        amount: 3000,
        status: 'succeeded',
        requestedAt: creada,
        completedAt: acreditada,
      },
    ]);
  });
});
