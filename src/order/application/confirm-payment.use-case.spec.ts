import { ConfirmPaymentUseCase } from './confirm-payment.use-case';
import { Order, PaymentStatus } from '../entities/order.entity';

/**
 * Caso de uso de confirmación de pago (webhook MercadoPago). Foco: idempotencia
 * (no despachar dos veces ante reintentos de MP) y que solo `approved` dispare
 * el despacho. La validación de FIRMA vive en el controller (ver
 * mercadopago-webhook.controller.spec.ts) — este use-case asume que ya se
 * validó, según su propio doc-comment.
 */
describe('ConfirmPaymentUseCase', () => {
  let useCase: ConfirmPaymentUseCase;

  let dataSource: any;
  let queryRunner: any;
  let queryBuilder: any;
  let lockedOrder: Partial<Order>;

  let orders: { findByIdFull: jest.Mock };
  let paymentGateway: { getPayment: jest.Mock };
  let dispatchOrchestrator: { offerToNextDriver: jest.Mock };

  const fullOrder = {
    order_id: 'ord-1',
    paymentStatus: PaymentStatus.PENDING,
    gatewayPaymentId: null,
    deliveryLatitude: '-34.6',
    deliveryLongitude: '-58.4',
    items: [],
  } as unknown as Order;

  beforeEach(() => {
    lockedOrder = {
      order_id: 'ord-1',
      paymentStatus: PaymentStatus.PENDING,
      gatewayPaymentId: null,
    };

    queryBuilder = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(() => Promise.resolve(lockedOrder)),
    };

    queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      manager: {
        createQueryBuilder: jest.fn(() => queryBuilder),
        save: jest.fn(async (o: any) => o),
      },
    };
    dataSource = { createQueryRunner: jest.fn(() => queryRunner) };

    orders = { findByIdFull: jest.fn().mockResolvedValue({ ...fullOrder }) };
    paymentGateway = { getPayment: jest.fn() };
    dispatchOrchestrator = {
      offerToNextDriver: jest.fn().mockResolvedValue('drv-1'),
    };

    useCase = new ConfirmPaymentUseCase(
      dataSource as any,
      orders as any,
      paymentGateway as any,
      dispatchOrchestrator as any,
    );
  });

  it('ignora notificaciones que no son de tipo payment', async () => {
    await useCase.execute({ type: 'merchant_order', dataId: '123' });
    expect(paymentGateway.getPayment).not.toHaveBeenCalled();
  });

  it('approved + no pagado: marca PAID, guarda gatewayPaymentId y despacha UNA vez', async () => {
    paymentGateway.getPayment.mockResolvedValue({
      id: 'pay-1',
      status: 'approved',
      externalReference: 'ord-1',
    });

    await useCase.execute({ type: 'payment', dataId: 'pay-1' });

    expect(queryRunner.manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentStatus: PaymentStatus.PAID,
        gatewayPaymentId: 'pay-1',
      }),
    );
    expect(dispatchOrchestrator.offerToNextDriver).toHaveBeenCalledTimes(1);
  });

  it('approved + ya pagado (idempotencia): NO re-despacha ni re-guarda', async () => {
    lockedOrder.paymentStatus = PaymentStatus.PAID;
    lockedOrder.gatewayPaymentId = 'pay-1';

    paymentGateway.getPayment.mockResolvedValue({
      id: 'pay-1',
      status: 'approved',
      externalReference: 'ord-1',
    });

    await useCase.execute({ type: 'payment', dataId: 'pay-1' });

    expect(queryRunner.manager.save).not.toHaveBeenCalled();
    expect(dispatchOrchestrator.offerToNextDriver).not.toHaveBeenCalled();
  });

  it('approved + reintento de MP con OTRO webhook mientras ya está pagado: idempotente igual', async () => {
    lockedOrder.paymentStatus = PaymentStatus.PENDING;
    lockedOrder.gatewayPaymentId = 'pay-1'; // ya confirmado por un pago previo

    paymentGateway.getPayment.mockResolvedValue({
      id: 'pay-1',
      status: 'approved',
      externalReference: 'ord-1',
    });

    await useCase.execute({ type: 'payment', dataId: 'pay-1' });

    expect(queryRunner.manager.save).not.toHaveBeenCalled();
    expect(dispatchOrchestrator.offerToNextDriver).not.toHaveBeenCalled();
  });

  it('rejected: no despacha ni marca como pagado', async () => {
    paymentGateway.getPayment.mockResolvedValue({
      id: 'pay-1',
      status: 'rejected',
      externalReference: 'ord-1',
    });

    await useCase.execute({ type: 'payment', dataId: 'pay-1' });

    expect(queryRunner.manager.save).not.toHaveBeenCalled();
    expect(dispatchOrchestrator.offerToNextDriver).not.toHaveBeenCalled();
  });

  it('pedido inexistente (external_reference huérfano): no revienta, no despacha', async () => {
    orders.findByIdFull.mockResolvedValue(null);
    paymentGateway.getPayment.mockResolvedValue({
      id: 'pay-1',
      status: 'approved',
      externalReference: 'ord-fantasma',
    });

    await expect(
      useCase.execute({ type: 'payment', dataId: 'pay-1' }),
    ).resolves.not.toThrow();
    expect(dispatchOrchestrator.offerToNextDriver).not.toHaveBeenCalled();
  });
});
