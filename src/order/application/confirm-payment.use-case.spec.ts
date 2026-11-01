import { ConfirmPaymentUseCase } from './confirm-payment.use-case';
import { Order, OrderStatus, PaymentStatus } from '../entities/order.entity';

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

  let dataSource: { createQueryRunner: jest.Mock };
  let queryRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    manager: {
      createQueryBuilder: jest.Mock;
      save: jest.Mock;
    };
  };
  let queryBuilder: {
    setLock: jest.Mock;
    where: jest.Mock;
    getOne: jest.Mock;
  };
  let lockedOrder: Partial<Order>;

  let orders: { findByIdFull: jest.Mock };
  let paymentsService: { confirmFromGateway: jest.Mock };
  let dispatchOrchestrator: { offerToNextDriver: jest.Mock };
  let dispatch: { notifyCustomer: jest.Mock };
  let notifications: { sendPaymentApprovedPush: jest.Mock };
  let refunds: {
    reintegrarPorCancelacion: jest.Mock;
    reintegrarPagoDuplicado: jest.Mock;
  };
  let events: { emit: jest.Mock };
  let offers: { withdrawOtherActiveOffers: jest.Mock };

  const fullOrder = {
    orderId: 'ord-1',
    paymentStatus: PaymentStatus.PENDING,
    gatewayPaymentId: null,
    deliveryPoint: { type: 'Point', coordinates: [-58.4, -34.6] },
    items: [],
  } as unknown as Order;

  beforeEach(() => {
    lockedOrder = {
      orderId: 'ord-1',
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
        save: jest.fn((o: unknown) => Promise.resolve(o)),
      },
    };
    dataSource = { createQueryRunner: jest.fn(() => queryRunner) };

    orders = { findByIdFull: jest.fn().mockResolvedValue({ ...fullOrder }) };
    paymentsService = { confirmFromGateway: jest.fn() };
    dispatchOrchestrator = {
      offerToNextDriver: jest.fn().mockResolvedValue('drv-1'),
    };

    dispatch = { notifyCustomer: jest.fn() };
    refunds = {
      reintegrarPorCancelacion: jest.fn().mockResolvedValue([]),
      reintegrarPagoDuplicado: jest
        .fn()
        .mockResolvedValue([{ status: 'succeeded' }]),
    };
    events = { emit: jest.fn() };
    notifications = {
      sendPaymentApprovedPush: jest.fn().mockResolvedValue(undefined),
    };

    offers = { withdrawOtherActiveOffers: jest.fn().mockResolvedValue([]) };

    useCase = new ConfirmPaymentUseCase(
      dataSource as unknown as import('typeorm').DataSource,
      orders as unknown as import('../domain/ports/order.repository.port').OrderRepositoryPort,
      paymentsService as unknown as import('../../payments/application/payments.service').PaymentsService,
      dispatchOrchestrator as unknown as import('./dispatch-orchestrator.service').DispatchOrchestratorService,
      dispatch as unknown as import('../domain/ports/realtime-dispatch.port').RealtimeDispatchPort,
      notifications as unknown as import('../domain/ports/notification.port').NotificationPort,
      refunds as unknown as import('../../payments/application/refunds.service').RefundsService,
      events as unknown as import('@nestjs/event-emitter').EventEmitter2,
      offers as never,
    );
  });

  describe('notificarResultadoDePago', () => {
    const aprobado = {
      externalReference: 'ord-1',
      gatewayPaymentId: 'pay-1',
      status: 'approved',
      isDeposit: false,
    };

    beforeEach(() => {
      orders.findByIdFull.mockResolvedValue({
        ...fullOrder,
        customerId: 'cus-1',
      });
      lockedOrder.customerId = 'cus-1';
    });

    it('al aprobarse avisa al cliente por socket y por push', async () => {
      paymentsService.confirmFromGateway.mockResolvedValue(aprobado);
      await useCase.execute({ type: 'payment', dataId: 'pay-1' });
      expect(dispatch.notifyCustomer).toHaveBeenCalledWith(
        'cus-1',
        'order:payment-approved',
        expect.objectContaining({ orderId: 'ord-1' }),
      );
      expect(notifications.sendPaymentApprovedPush).toHaveBeenCalledWith(
        'cus-1',
        'ord-1',
        false,
      );
    });

    it('la seña de una reserva avisa con tipo deposit y el estado real, y después de liberar la conexión', async () => {
      lockedOrder.status = OrderStatus.RESERVED;
      paymentsService.confirmFromGateway.mockResolvedValue({
        ...aprobado,
        isDeposit: true,
      });
      await useCase.execute({ type: 'payment', dataId: 'pay-1' });
      expect(dispatch.notifyCustomer).toHaveBeenCalledWith(
        'cus-1',
        'order:payment-approved',
        expect.objectContaining({
          tipo: 'deposit',
          paymentStatus: PaymentStatus.PENDING,
        }),
      );
      expect(notifications.sendPaymentApprovedPush).toHaveBeenCalledWith(
        'cus-1',
        'ord-1',
        true,
      );
      expect(queryRunner.release.mock.invocationCallOrder[0]).toBeLessThan(
        notifications.sendPaymentApprovedPush.mock.invocationCallOrder[0],
      );
      expect(dispatchOrchestrator.offerToNextDriver).not.toHaveBeenCalled();
    });

    it('el pago completo despacha primero y el push no frena el despacho', async () => {
      notifications.sendPaymentApprovedPush.mockReturnValue(
        new Promise(() => undefined), // FCM colgado
      );
      paymentsService.confirmFromGateway.mockResolvedValue(aprobado);
      await expect(
        useCase.execute({ type: 'payment', dataId: 'pay-1' }),
      ).resolves.toBeUndefined();
      expect(
        dispatchOrchestrator.offerToNextDriver.mock.invocationCallOrder[0],
      ).toBeLessThan(
        notifications.sendPaymentApprovedPush.mock.invocationCallOrder[0],
      );
      expect(notifications.sendPaymentApprovedPush).toHaveBeenCalledWith(
        'cus-1',
        'ord-1',
        false,
      );
    });

    it('un reintento del webhook (ya confirmado) no vuelve a avisar', async () => {
      lockedOrder.paymentStatus = PaymentStatus.PAID;
      lockedOrder.gatewayPaymentId = 'pay-1';
      paymentsService.confirmFromGateway.mockResolvedValue(aprobado);
      await useCase.execute({ type: 'payment', dataId: 'pay-1' });
      expect(dispatch.notifyCustomer).not.toHaveBeenCalled();
      expect(notifications.sendPaymentApprovedPush).not.toHaveBeenCalled();
    });

    it('un pago rechazado no avisa de aprobación', async () => {
      paymentsService.confirmFromGateway.mockResolvedValue({
        ...aprobado,
        status: 'rejected',
      });
      await useCase.execute({ type: 'payment', dataId: 'pay-1' });
      expect(notifications.sendPaymentApprovedPush).not.toHaveBeenCalled();
    });

    it('si la notificación falla, la confirmación y el despacho siguen', async () => {
      dispatch.notifyCustomer.mockImplementation(() => {
        throw new Error('socket caído');
      });
      notifications.sendPaymentApprovedPush.mockRejectedValue(
        new Error('fcm caído'),
      );
      paymentsService.confirmFromGateway.mockResolvedValue(aprobado);
      await expect(
        useCase.execute({ type: 'payment', dataId: 'pay-1' }),
      ).resolves.toBeUndefined();
      expect(queryRunner.manager.save).toHaveBeenCalled();
      expect(dispatchOrchestrator.offerToNextDriver).toHaveBeenCalledTimes(1);
    });
  });

  describe('CU-168: pago aprobado que llega con el pedido ya cerrado', () => {
    const aprobado = {
      externalReference: 'ord-1',
      gatewayPaymentId: 'pay-1',
      status: 'approved',
      isDeposit: false,
    };

    it('sobre un pedido CANCELADO pide devolver ese pago y no despacha', async () => {
      lockedOrder.status = OrderStatus.CANCELLED;
      paymentsService.confirmFromGateway.mockResolvedValue(aprobado);

      await useCase.execute({ type: 'payment', dataId: 'pay-1' });

      expect(refunds.reintegrarPorCancelacion).toHaveBeenCalledWith('ord-1');
      expect(dispatchOrchestrator.offerToNextDriver).not.toHaveBeenCalled();
    });

    it('sobre un pedido ya ENTREGADO no devuelve nada', async () => {
      lockedOrder.status = OrderStatus.DELIVERED;
      paymentsService.confirmFromGateway.mockResolvedValue(aprobado);

      await useCase.execute({ type: 'payment', dataId: 'pay-1' });

      expect(refunds.reintegrarPorCancelacion).not.toHaveBeenCalled();
    });

    it('si no se puede dejar registrada la devolución el error SE PROPAGA (503 y reintento): un pago cobrado no se pierde', async () => {
      lockedOrder.status = OrderStatus.CANCELLED;
      refunds.reintegrarPorCancelacion.mockRejectedValue(
        new Error('base caída'),
      );
      paymentsService.confirmFromGateway.mockResolvedValue(aprobado);

      await expect(
        useCase.execute({ type: 'payment', dataId: 'pay-1' }),
      ).rejects.toThrow('base caída');
    });
  });

  it('delega en PaymentsService.confirmFromGateway con type/dataId', async () => {
    paymentsService.confirmFromGateway.mockResolvedValue(null);

    await useCase.execute({ type: 'payment', dataId: '123' });

    expect(paymentsService.confirmFromGateway).toHaveBeenCalledWith({
      type: 'payment',
      dataId: '123',
    });
  });

  it('pasa el origen de la lectura (webhook, conciliación) a PaymentsService para el historial', async () => {
    paymentsService.confirmFromGateway.mockResolvedValue(null);

    await useCase.execute({
      type: 'payment',
      dataId: '123',
      origin: 'conciliacion' as never,
    });

    expect(paymentsService.confirmFromGateway).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'conciliacion' }),
    );
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
        paymentConfirmedAt: expect.any(Date) as Date,
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

  it('approved por un monto distinto del esperado: no lo da por pagado, no despacha ni avisa', async () => {
    paymentsService.confirmFromGateway.mockResolvedValue({
      externalReference: 'ord-1',
      gatewayPaymentId: 'pay-1',
      status: 'approved',
      isDeposit: false,
      montoDistinto: { esperado: 15000, cobrado: 1500 },
    });

    await useCase.execute({ type: 'payment', dataId: 'pay-1' });

    expect(queryRunner.manager.save).not.toHaveBeenCalled();
    expect(dispatchOrchestrator.offerToNextDriver).not.toHaveBeenCalled();
    expect(dispatch.notifyCustomer).not.toHaveBeenCalled();
  });

  it('B-4: un monto distinto avisa al administrador aunque el pedido esté cancelado (nadie lo devolvería solo)', async () => {
    orders.findByIdFull.mockResolvedValue({
      ...fullOrder,
      distributorId: 'dist-1',
    });
    lockedOrder.status = OrderStatus.CANCELLED;
    paymentsService.confirmFromGateway.mockResolvedValue({
      externalReference: 'ord-1',
      gatewayPaymentId: 'pay-1',
      status: 'approved',
      isDeposit: false,
      montoDistinto: { esperado: 1000, cobrado: 100 },
    });

    await useCase.execute({ type: 'payment', dataId: 'pay-1' });

    const aviso = (
      events.emit.mock.calls as [string, Record<string, string>][]
    )[0][1];
    expect(aviso).toMatchObject({
      kind: 'payment_needs_review',
      dedupeKey: 'mp-revisar:ord-1:pay-1',
    });
  });

  it('también la seña de una reserva aprobada por un monto distinto queda sin acreditar', async () => {
    paymentsService.confirmFromGateway.mockResolvedValue({
      externalReference: 'ord-1',
      gatewayPaymentId: 'pay-1',
      status: 'approved',
      isDeposit: true,
      montoDistinto: { esperado: 5000, cobrado: 500 },
    });

    await useCase.execute({ type: 'payment', dataId: 'pay-1' });

    expect(queryRunner.manager.save).not.toHaveBeenCalled();
  });

  describe('pago rechazado o cancelado en Mercado Pago', () => {
    const rechazado = (status: string, isDeposit = false) => ({
      externalReference: 'ord-1',
      gatewayPaymentId: 'pay-1',
      status,
      isDeposit,
    });

    beforeEach(() => {
      lockedOrder.status = OrderStatus.PENDING;
      lockedOrder.customerId = 'cus-1';
      orders.findByIdFull.mockResolvedValue({
        ...fullOrder,
        customerId: 'cus-1',
      });
    });

    it.each(['rejected', 'cancelled'])(
      '%s: el pedido queda con el pago fallido, sin despachar, sin gatewayPaymentId y avisa al cliente',
      async (status) => {
        paymentsService.confirmFromGateway.mockResolvedValue(rechazado(status));

        await useCase.execute({ type: 'payment', dataId: 'pay-1' });

        expect(lockedOrder.paymentStatus).toBe(PaymentStatus.FAILED);
        expect(lockedOrder.gatewayPaymentId).toBeNull();
        expect(lockedOrder.status).toBe(OrderStatus.PENDING);
        expect(queryRunner.manager.save).toHaveBeenCalledTimes(1);
        expect(dispatchOrchestrator.offerToNextDriver).not.toHaveBeenCalled();
        expect(dispatch.notifyCustomer).toHaveBeenCalledWith(
          'cus-1',
          'order:payment-rejected',
          expect.objectContaining({
            orderId: 'ord-1',
            paymentStatus: PaymentStatus.FAILED,
          }),
        );
      },
    );

    it('un rechazo atrasado no pisa un pedido ya pagado', async () => {
      lockedOrder.paymentStatus = PaymentStatus.PAID;
      paymentsService.confirmFromGateway.mockResolvedValue(
        rechazado('rejected'),
      );

      await useCase.execute({ type: 'payment', dataId: 'pay-1' });

      expect(lockedOrder.paymentStatus).toBe(PaymentStatus.PAID);
      expect(queryRunner.manager.save).not.toHaveBeenCalled();
      expect(dispatch.notifyCustomer).not.toHaveBeenCalled();
    });

    it('no toca un pedido ya cancelado', async () => {
      lockedOrder.status = OrderStatus.CANCELLED;
      paymentsService.confirmFromGateway.mockResolvedValue(
        rechazado('rejected'),
      );

      await useCase.execute({ type: 'payment', dataId: 'pay-1' });

      expect(queryRunner.manager.save).not.toHaveBeenCalled();
    });

    it('la seña rechazada de una reserva no cambia el pedido', async () => {
      lockedOrder.status = OrderStatus.RESERVED;
      paymentsService.confirmFromGateway.mockResolvedValue(
        rechazado('rejected', true),
      );

      await useCase.execute({ type: 'payment', dataId: 'pay-1' });

      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
      expect(dispatch.notifyCustomer).not.toHaveBeenCalled();
    });

    it('después de un rechazo, un reintento aprobado lo pasa a pagado y despacha', async () => {
      lockedOrder.paymentStatus = PaymentStatus.FAILED;
      paymentsService.confirmFromGateway.mockResolvedValue({
        ...rechazado('approved'),
        gatewayPaymentId: 'pay-2',
      });

      await useCase.execute({ type: 'payment', dataId: 'pay-2' });

      expect(lockedOrder.paymentStatus).toBe(PaymentStatus.PAID);
      expect(lockedOrder.gatewayPaymentId).toBe('pay-2');
      expect(dispatchOrchestrator.offerToNextDriver).toHaveBeenCalledTimes(1);
    });
  });

  describe('devolución hecha por Mercado Pago', () => {
    const devuelto = (contracargo: boolean) => ({
      externalReference: 'ord-1',
      gatewayPaymentId: 'pay-1',
      status: contracargo ? 'charged_back' : 'refunded',
      isDeposit: false,
      devolucionExterna: { contracargo },
    });

    beforeEach(() => {
      orders.findByIdFull.mockResolvedValue({
        ...fullOrder,
        distributorId: 'dist-1',
      });
    });

    it.each([
      [false, 'payment_refunded'],
      [true, 'payment_chargeback'],
    ])(
      'avisa al administrador sin tocar el pedido (contracargo=%s)',
      async (contracargo, kind) => {
        paymentsService.confirmFromGateway.mockResolvedValue(
          devuelto(contracargo),
        );

        await useCase.execute({ type: 'payment', dataId: 'pay-1' });

        expect(events.emit).toHaveBeenCalledWith(
          'admin.notificar',
          expect.objectContaining({
            distributorId: 'dist-1',
            kind,
            link: { entity: 'order', id: 'ord-1' },
          }),
        );
        expect(queryRunner.manager.save).not.toHaveBeenCalled();
        expect(refunds.reintegrarPorCancelacion).not.toHaveBeenCalled();
        expect(dispatchOrchestrator.offerToNextDriver).not.toHaveBeenCalled();
      },
    );

    it('una devolución que el sistema ya hizo (sin devolucionExterna) no avisa', async () => {
      paymentsService.confirmFromGateway.mockResolvedValue({
        externalReference: 'ord-1',
        gatewayPaymentId: 'pay-1',
        status: 'refunded',
        isDeposit: false,
      });

      await useCase.execute({ type: 'payment', dataId: 'pay-1' });

      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('A3: segundo cobro del mismo checkout sobre un pedido ya pagado', () => {
    const segundo = {
      externalReference: 'ord-1',
      gatewayPaymentId: 'pay-2',
      status: 'approved',
      isDeposit: false,
    };

    beforeEach(() => {
      orders.findByIdFull.mockResolvedValue({
        ...fullOrder,
        distributorId: 'dist-1',
      });
      lockedOrder.paymentStatus = PaymentStatus.PAID;
      lockedOrder.gatewayPaymentId = 'pay-1';
      paymentsService.confirmFromGateway.mockResolvedValue(segundo);
    });

    const aviso = () =>
      (events.emit.mock.calls as [string, Record<string, string>][]).map(
        ([, a]) => a,
      );

    it('devuelve ESE pago (no el primero), no despacha de nuevo y avisa al admin', async () => {
      await useCase.execute({ type: 'payment', dataId: 'pay-2' });

      expect(refunds.reintegrarPagoDuplicado).toHaveBeenCalledWith('pay-2');
      expect(refunds.reintegrarPorCancelacion).not.toHaveBeenCalled();
      expect(dispatchOrchestrator.offerToNextDriver).not.toHaveBeenCalled();
      expect(queryRunner.manager.save).not.toHaveBeenCalled();
      expect(aviso()[0]).toMatchObject({
        kind: 'payment_duplicate',
        dedupeKey: 'mp-duplicado:pay-2',
        distributorId: 'dist-1',
      });
      expect(aviso()[0].body).toContain('ya se devolvió');
    });

    it('si la devolución quedó pendiente el aviso lo dice', async () => {
      refunds.reintegrarPagoDuplicado.mockResolvedValue([{ status: 'failed' }]);

      await useCase.execute({ type: 'payment', dataId: 'pay-2' });

      expect(aviso()[0].body).toContain('quedó pendiente');
    });

    it('el mismo pago otra vez (reintento del webhook) NO es un duplicado', async () => {
      paymentsService.confirmFromGateway.mockResolvedValue({
        ...segundo,
        gatewayPaymentId: 'pay-1',
      });

      await useCase.execute({ type: 'payment', dataId: 'pay-1' });

      expect(refunds.reintegrarPagoDuplicado).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('un pedido pagado por otro camino (sin id de pasarela) tampoco admite el cobro de Mercado Pago', async () => {
      lockedOrder.gatewayPaymentId = null;

      await useCase.execute({ type: 'payment', dataId: 'pay-2' });

      expect(refunds.reintegrarPagoDuplicado).toHaveBeenCalledWith('pay-2');
    });

    it('sobre un pedido ENTREGADO con otro pago ya registrado también se devuelve', async () => {
      lockedOrder.status = OrderStatus.DELIVERED;

      await useCase.execute({ type: 'payment', dataId: 'pay-2' });

      expect(refunds.reintegrarPagoDuplicado).toHaveBeenCalledWith('pay-2');
    });

    it('un pedido cancelado no lo trata como duplicado: devuelve todo por cancelación', async () => {
      lockedOrder.status = OrderStatus.CANCELLED;

      await useCase.execute({ type: 'payment', dataId: 'pay-2' });

      expect(refunds.reintegrarPorCancelacion).toHaveBeenCalledWith('ord-1');
      expect(refunds.reintegrarPagoDuplicado).not.toHaveBeenCalled();
    });

    it('si no se puede registrar la devolución del duplicado el error se propaga (503 y reintento)', async () => {
      refunds.reintegrarPagoDuplicado.mockRejectedValue(
        new Error('sin ledger'),
      );

      await expect(
        useCase.execute({ type: 'payment', dataId: 'pay-2' }),
      ).rejects.toThrow('sin ledger');
    });
  });

  describe('S-1: contracargo reintegrado sin resolución del caso', () => {
    it('avisa al admin que lo concilie a mano, sin asentar nada', async () => {
      orders.findByIdFull.mockResolvedValue({
        ...fullOrder,
        distributorId: 'dist-1',
      });
      paymentsService.confirmFromGateway.mockResolvedValue({
        externalReference: 'ord-1',
        gatewayPaymentId: 'pay-1',
        status: 'charged_back',
        isDeposit: false,
        contracargoAConciliar: true,
      });

      await useCase.execute({ type: 'payment', dataId: 'pay-1' });

      const aviso = (
        events.emit.mock.calls as [string, Record<string, string>][]
      )[0][1];
      expect(aviso).toMatchObject({
        kind: 'payment_chargeback_review',
        dedupeKey: 'mp-contracargo-conciliar:pay-1',
      });
    });
  });

  describe('M-2: contracargo reintegrado al comercio', () => {
    it('avisa al administrador una sola vez por pago', async () => {
      orders.findByIdFull.mockResolvedValue({
        ...fullOrder,
        distributorId: 'dist-1',
      });
      paymentsService.confirmFromGateway.mockResolvedValue({
        externalReference: 'ord-1',
        gatewayPaymentId: 'pay-1',
        status: 'charged_back',
        isDeposit: false,
        contracargoReintegrado: true,
      });

      await useCase.execute({ type: 'payment', dataId: 'pay-1' });

      const aviso = (
        events.emit.mock.calls as [string, Record<string, string>][]
      )[0][1];
      expect(aviso).toMatchObject({
        kind: 'payment_chargeback_resolved',
        dedupeKey: 'mp-contracargo-resuelto:pay-1',
      });
    });
  });

  describe('estados de Mercado Pago que no cambian el pedido', () => {
    it.each([
      'pending',
      'in_process',
      'authorized',
      'refunded',
      'charged_back',
    ])(
      '%s: el pedido no se paga, no se rechaza ni se despacha',
      async (status) => {
        paymentsService.confirmFromGateway.mockResolvedValue({
          externalReference: 'ord-1',
          gatewayPaymentId: 'pay-1',
          status,
          isDeposit: false,
        });

        await useCase.execute({ type: 'payment', dataId: 'pay-1' });

        expect(queryRunner.manager.save).not.toHaveBeenCalled();
        expect(dispatchOrchestrator.offerToNextDriver).not.toHaveBeenCalled();
        expect(dispatch.notifyCustomer).not.toHaveBeenCalled();
      },
    );

    it('in_mediation sobre un pedido que no se había enterado del cobro lo da por pagado (el pago ya se había acreditado)', async () => {
      paymentsService.confirmFromGateway.mockResolvedValue({
        externalReference: 'ord-1',
        gatewayPaymentId: 'pay-1',
        status: 'in_mediation',
        isDeposit: false,
      });

      await useCase.execute({ type: 'payment', dataId: 'pay-1' });

      expect(queryRunner.manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentStatus: PaymentStatus.PAID,
          gatewayPaymentId: 'pay-1',
        }),
      );
    });

    it('in_mediation sobre un pedido ya pagado no hace nada más', async () => {
      lockedOrder.paymentStatus = PaymentStatus.PAID;
      lockedOrder.gatewayPaymentId = 'pay-1';
      paymentsService.confirmFromGateway.mockResolvedValue({
        externalReference: 'ord-1',
        gatewayPaymentId: 'pay-1',
        status: 'in_mediation',
        isDeposit: false,
      });

      await useCase.execute({ type: 'payment', dataId: 'pay-1' });

      expect(queryRunner.manager.save).not.toHaveBeenCalled();
      expect(dispatchOrchestrator.offerToNextDriver).not.toHaveBeenCalled();
    });
  });

  describe('M6: alerta de fraude (stop_delivery_op_wh)', () => {
    const alerta = {
      externalReference: 'ord-1',
      gatewayPaymentId: 'pay-1',
      status: 'approved',
      isDeposit: false,
      alertaDeFraude: true,
    };
    const avisos = () =>
      (events.emit.mock.calls as [string, Record<string, string>][]).map(
        ([, a]) => a,
      );

    beforeEach(() => {
      orders.findByIdFull.mockResolvedValue({
        ...fullOrder,
        distributorId: 'dist-1',
      });
      lockedOrder.status = OrderStatus.PENDING;
      lockedOrder.paymentStatus = PaymentStatus.PAID;
      lockedOrder.gatewayPaymentId = 'pay-1';
      lockedOrder.deliveryId = null;
      paymentsService.confirmFromGateway.mockResolvedValue(alerta);
    });

    it('frena el despacho de un pedido sin chofer con la retención por fraude (el pago sigue pago) y no se ofrece', async () => {
      await useCase.execute({ type: 'stop_delivery_op_wh', dataId: 'pay-1' });

      expect(queryRunner.manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentFraudHold: true,
          paymentStatus: PaymentStatus.PAID,
        }),
      );
      expect(dispatchOrchestrator.offerToNextDriver).not.toHaveBeenCalled();
    });

    it('M-2: al retener retira las ofertas vivas a choferes (superseded) en la misma transacción', async () => {
      await useCase.execute({ type: 'stop_delivery_op_wh', dataId: 'pay-1' });

      expect(offers.withdrawOtherActiveOffers).toHaveBeenCalledWith(
        queryRunner.manager,
        'ord-1',
        null,
        'superseded',
      );
    });

    it('un pedido que ya tiene chofer no retira ofertas', async () => {
      lockedOrder.deliveryId = 'chofer-1';
      lockedOrder.status = OrderStatus.ON_THE_WAY;

      await useCase.execute({ type: 'stop_delivery_op_wh', dataId: 'pay-1' });

      expect(offers.withdrawOtherActiveOffers).not.toHaveBeenCalled();
    });

    it('avisa al administrador (con mail) una sola vez por pago', async () => {
      await useCase.execute({ type: 'stop_delivery_op_wh', dataId: 'pay-1' });

      expect(avisos()[0]).toMatchObject({
        kind: 'payment_fraud_alert',
        dedupeKey: 'mp-fraude:pay-1',
        distributorId: 'dist-1',
        email: true,
      });
      expect(avisos()[0].body).toContain('Se frenó el despacho');
    });

    it('M-3: una reserva con la seña paga también se retiene (no se activa ni se despacha)', async () => {
      lockedOrder.status = OrderStatus.RESERVED;
      lockedOrder.paymentStatus = PaymentStatus.PENDING;
      lockedOrder.depositPaid = true;

      await useCase.execute({ type: 'stop_delivery_op_wh', dataId: 'pay-1' });

      expect(queryRunner.manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ paymentFraudHold: true }),
      );
      expect(avisos()[0].body).toContain('Se frenó el despacho');
    });

    it('un pedido que ya tiene chofer no se toca: sólo el aviso, urgente', async () => {
      lockedOrder.deliveryId = 'chofer-1';
      lockedOrder.status = OrderStatus.ON_THE_WAY;

      await useCase.execute({ type: 'stop_delivery_op_wh', dataId: 'pay-1' });

      expect(queryRunner.manager.save).not.toHaveBeenCalled();
      expect(avisos()[0].body).toContain('urgente');
    });
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
