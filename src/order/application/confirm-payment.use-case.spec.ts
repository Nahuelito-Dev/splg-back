import { ConfirmPaymentUseCase } from './confirm-payment.use-case';
import { Order, PaymentStatus } from '../entities/order.entity';

/**
 * Caso de uso de confirmación de pago (webhook MercadoPago). Foco: idempotencia
 * (no despachar dos veces ante reintentos de MP) y que solo `approved` dispare
 * el despacho. La validación de FIRMA vive en el controller (ver
 * mercadopago-webhook.controller.spec.ts), y la interpretación cruda de la
 * pasarela + el ledger viven en `PaymentsService` (ver
 * payments/application/payments.service.spec.ts) — acá se mockea su resultado
 * ya NORMALIZADO. Este use-case asume que ya se validó la firma, según su
 * propio doc-comment.
 */
describe('ConfirmPaymentUseCase', () => {
  let useCase: ConfirmPaymentUseCase;

  let dataSource: any;
  let queryRunner: any;
  let queryBuilder: any;
  let lockedOrder: Partial<Order>;

  let orders: { findByIdFull: jest.Mock };
  let paymentsService: { confirmFromGateway: jest.Mock };
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
    paymentsService = { confirmFromGateway: jest.fn() };
    dispatchOrchestrator = {
      offerToNextDriver: jest.fn().mockResolvedValue('drv-1'),
    };

    useCase = new ConfirmPaymentUseCase(
      dataSource as any,
      orders as any,
      paymentsService as any,
      dispatchOrchestrator as any,
    );
  });

  it('delega en PaymentsService.confirmFromGateway con type/dataId', async () => {
    paymentsService.confirmFromGateway.mockResolvedValue(null);

    await useCase.execute({ type: 'payment', dataId: '123' });

    expect(paymentsService.confirmFromGateway).toHaveBeenCalledWith({
      type: 'payment',
      dataId: '123',
    });
  });

  it('PaymentsService descarta la notificación (tipo irrelevante, sin dataId, etc.): no busca el pedido', async () => {
    paymentsService.confirmFromGateway.mockResolvedValue(null);

    await useCase.execute({ type: 'merchant_order', dataId: '123' });

    expect(orders.findByIdFull).not.toHaveBeenCalled();
  });

  it('approved + no pagado: marca PAID, guarda gatewayPaymentId y despacha UNA vez', async () => {
    paymentsService.confirmFromGateway.mockResolvedValue({
      externalReference: 'ord-1',
      gatewayPaymentId: 'pay-1',
      status: 'approved',
      isDeposit: false,
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

    paymentsService.confirmFromGateway.mockResolvedValue({
      externalReference: 'ord-1',
      gatewayPaymentId: 'pay-1',
      status: 'approved',
      isDeposit: false,
    });

    await useCase.execute({ type: 'payment', dataId: 'pay-1' });

    expect(queryRunner.manager.save).not.toHaveBeenCalled();
    expect(dispatchOrchestrator.offerToNextDriver).not.toHaveBeenCalled();
  });

  it('approved + reintento de MP con OTRO webhook mientras ya está pagado: idempotente igual', async () => {
    lockedOrder.paymentStatus = PaymentStatus.PENDING;
    lockedOrder.gatewayPaymentId = 'pay-1'; // ya confirmado por un pago previo

    paymentsService.confirmFromGateway.mockResolvedValue({
      externalReference: 'ord-1',
      gatewayPaymentId: 'pay-1',
      status: 'approved',
      isDeposit: false,
    });

    await useCase.execute({ type: 'payment', dataId: 'pay-1' });

    expect(queryRunner.manager.save).not.toHaveBeenCalled();
    expect(dispatchOrchestrator.offerToNextDriver).not.toHaveBeenCalled();
  });

  it('rejected: no despacha ni marca como pagado', async () => {
    paymentsService.confirmFromGateway.mockResolvedValue({
      externalReference: 'ord-1',
      gatewayPaymentId: 'pay-1',
      status: 'rejected',
      isDeposit: false,
    });

    await useCase.execute({ type: 'payment', dataId: 'pay-1' });

    expect(queryRunner.manager.save).not.toHaveBeenCalled();
    expect(dispatchOrchestrator.offerToNextDriver).not.toHaveBeenCalled();
  });

  it('pedido inexistente (external_reference huérfano): no revienta, no despacha', async () => {
    orders.findByIdFull.mockResolvedValue(null);
    paymentsService.confirmFromGateway.mockResolvedValue({
      externalReference: 'ord-fantasma',
      gatewayPaymentId: 'pay-1',
      status: 'approved',
      isDeposit: false,
    });

    await expect(
      useCase.execute({ type: 'payment', dataId: 'pay-1' }),
    ).resolves.not.toThrow();
    expect(dispatchOrchestrator.offerToNextDriver).not.toHaveBeenCalled();
  });
});
