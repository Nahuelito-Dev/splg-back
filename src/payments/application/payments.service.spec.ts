import { Repository } from 'typeorm';
import { PaymentsService } from './payments.service';
import { Payment } from '../entities/payment.entity';
import { PaymentGatewayPort } from '../domain/ports/payment-gateway.port';
import { LedgerPaymentStatus } from '../domain/payment.enums';

/**
 * Servicio de pagos, GATEWAY-AGNÓSTICO: habla contra `PaymentGatewayPort`
 * (mockeado acá, nunca contra MercadoPago real) y mantiene el ledger
 * (`Payment`). Foco de estos tests: que `createCheckout` deje rastro en el
 * ledger ANTES de llamar a la pasarela y lo complete después, que
 * `confirmFromGateway` sea idempotente (no duplica ledger ante reintentos del
 * webhook) y devuelva `null` cuando no hay nada que procesar, y que
 * `verifyWebhookSignature` delegue sin lógica propia.
 */
describe('PaymentsService', () => {
  let service: PaymentsService;
  let paymentRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
  };
  let paymentGateway: {
    createCheckout: jest.Mock;
    getPayment: jest.Mock;
    verifyWebhookSignature: jest.Mock;
  };

  beforeEach(() => {
    paymentRepository = {
      create: jest.fn((data: Partial<Payment>) => ({ ...data })),
      save: jest.fn((entity: Payment) => Promise.resolve(entity)),
      findOne: jest.fn(),
    };
    paymentGateway = {
      createCheckout: jest.fn(),
      getPayment: jest.fn(),
      verifyWebhookSignature: jest.fn(),
    };

    service = new PaymentsService(
      paymentRepository as unknown as Repository<Payment>,
      paymentGateway as unknown as PaymentGatewayPort,
    );
  });

  describe('createCheckout', () => {
    it('crea el registro de ledger PENDING, delega en la pasarela y completa payment_url/preferenceId', async () => {
      paymentGateway.createCheckout.mockResolvedValue({
        initPoint: 'https://mp.test/checkout',
        preferenceId: 'pref-1',
      });

      const result = await service.createCheckout({
        orderId: 'ord-1',
        distributorId: 'dist-1',
        amount: 2000,
        isDeposit: false,
        items: [
          { id: 'gc-1', title: 'Garrafa 10kg', quantity: 2, unitPrice: 1000 },
        ],
        payerEmail: 'cliente@test.com',
      });

      // Ledger creado ANTES de llamar a la pasarela.
      expect(paymentRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: 'ord-1',
          distributorId: 'dist-1',
          amount: 2000,
          isDeposit: false,
          status: LedgerPaymentStatus.PENDING,
          externalReference: 'ord-1',
        }),
      );

      expect(paymentGateway.createCheckout).toHaveBeenCalledWith({
        orderId: 'ord-1',
        items: [
          { id: 'gc-1', title: 'Garrafa 10kg', quantity: 2, unitPrice: 1000 },
        ],
        payerEmail: 'cliente@test.com',
      });

      // Se guarda dos veces: al crear el PENDING y al completar payment_url.
      expect(paymentRepository.save).toHaveBeenCalledTimes(2);
      const lastSaved = (
        paymentRepository.save.mock.calls as Payment[][]
      )[1][0];
      expect(lastSaved.paymentUrl).toBe('https://mp.test/checkout');
      expect(lastSaved.metadata).toEqual({ preferenceId: 'pref-1' });

      expect(result).toEqual({
        initPoint: 'https://mp.test/checkout',
        preferenceId: 'pref-1',
      });
    });

    it('seña de reserva: isDeposit true y monto = seña', async () => {
      paymentGateway.createCheckout.mockResolvedValue({
        initPoint: 'https://mp.test/deposit',
        preferenceId: 'pref-deposit',
      });

      await service.createCheckout({
        orderId: 'ord-2',
        distributorId: null,
        amount: 500,
        isDeposit: true,
        items: [
          {
            id: 'deposit-ord-2',
            title: 'Seña de reserva',
            quantity: 1,
            unitPrice: 500,
          },
        ],
        payerEmail: 'cliente@test.com',
      });

      expect(paymentRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ isDeposit: true, amount: 500 }),
      );
    });

    it('si la pasarela falla, el ledger queda PENDING sin payment_url (no revienta el registro)', async () => {
      paymentGateway.createCheckout.mockRejectedValue(new Error('MP caído'));

      await expect(
        service.createCheckout({
          orderId: 'ord-1',
          amount: 2000,
          isDeposit: false,
          items: [],
          payerEmail: 'cliente@test.com',
        }),
      ).rejects.toThrow('MP caído');

      // Solo el save del alta (PENDING); nunca se llegó a completar payment_url.
      expect(paymentRepository.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('confirmFromGateway', () => {
    it('type distinto de "payment": no consulta la pasarela, devuelve null', async () => {
      const result = await service.confirmFromGateway({
        type: 'merchant_order',
        dataId: '123',
      });

      expect(paymentGateway.getPayment).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it('sin dataId: no consulta la pasarela, devuelve null', async () => {
      const result = await service.confirmFromGateway({ type: 'payment' });

      expect(paymentGateway.getPayment).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it('la consulta a la pasarela falla: devuelve null (no revienta)', async () => {
      paymentGateway.getPayment.mockRejectedValue(new Error('timeout'));

      const result = await service.confirmFromGateway({
        type: 'payment',
        dataId: 'pay-1',
      });

      expect(result).toBeNull();
    });

    it('pago sin external_reference: devuelve null', async () => {
      paymentGateway.getPayment.mockResolvedValue({
        id: 'pay-1',
        status: 'approved',
        externalReference: null,
      });

      const result = await service.confirmFromGateway({
        type: 'payment',
        dataId: 'pay-1',
      });

      expect(result).toBeNull();
    });

    it('primera notificación: matchea el Payment PENDING por external_reference, lo actualiza y normaliza el resultado', async () => {
      paymentGateway.getPayment.mockResolvedValue({
        id: 'pay-1',
        status: 'approved',
        externalReference: 'ord-1',
      });

      const pendingLedger = {
        paymentId: 'ledger-1',
        orderId: 'ord-1',
        externalReference: 'ord-1',
        gatewayPaymentId: null,
        isDeposit: false,
        status: LedgerPaymentStatus.PENDING,
        metadata: null,
      };
      // 1ra búsqueda (por gateway_payment_id) no encuentra nada; 2da (por
      // external_reference PENDING) encuentra el registro creado en checkout.
      paymentRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(pendingLedger);

      const result = await service.confirmFromGateway({
        type: 'payment',
        dataId: 'pay-1',
      });

      expect(paymentRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          gatewayPaymentId: 'pay-1',
          status: LedgerPaymentStatus.APPROVED,
        }),
      );

      expect(result).toEqual({
        externalReference: 'ord-1',
        gatewayPaymentId: 'pay-1',
        status: 'approved',
        isDeposit: false,
      });
    });

    it('reintento de MP (mismo gateway_payment_id): idempotente, NO duplica el ledger', async () => {
      paymentGateway.getPayment.mockResolvedValue({
        id: 'pay-1',
        status: 'approved',
        externalReference: 'ord-1',
      });

      const alreadyConfirmedLedger = {
        paymentId: 'ledger-1',
        orderId: 'ord-1',
        externalReference: 'ord-1',
        gatewayPaymentId: 'pay-1',
        isDeposit: true,
        status: LedgerPaymentStatus.APPROVED,
        metadata: { gatewayStatus: 'approved' },
      };
      // Se encuentra directo por gateway_payment_id: NO se busca por
      // external_reference (evita matchear otro registro y "duplicar").
      paymentRepository.findOne.mockResolvedValueOnce(alreadyConfirmedLedger);

      const result = await service.confirmFromGateway({
        type: 'payment',
        dataId: 'pay-1',
      });

      expect(paymentRepository.findOne).toHaveBeenCalledTimes(1);
      expect(paymentRepository.create).not.toHaveBeenCalled();
      expect(result).toEqual({
        externalReference: 'ord-1',
        gatewayPaymentId: 'pay-1',
        status: 'approved',
        isDeposit: true,
      });
    });

    it('pago sin Payment de ledger asociado: no revienta, isDeposit=false por defecto', async () => {
      paymentGateway.getPayment.mockResolvedValue({
        id: 'pay-huerfano',
        status: 'approved',
        externalReference: 'ord-sin-checkout',
      });
      paymentRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const result = await service.confirmFromGateway({
        type: 'payment',
        dataId: 'pay-huerfano',
      });

      expect(paymentRepository.save).not.toHaveBeenCalled();
      expect(result).toEqual({
        externalReference: 'ord-sin-checkout',
        gatewayPaymentId: 'pay-huerfano',
        status: 'approved',
        isDeposit: false,
      });
    });
  });

  describe('verifyWebhookSignature', () => {
    it('delega en el port, sin lógica propia', () => {
      paymentGateway.verifyWebhookSignature.mockReturnValue(true);

      const result = service.verifyWebhookSignature({
        xSignature: 'sig',
        xRequestId: 'req',
        dataId: 'pay-1',
      });

      expect(paymentGateway.verifyWebhookSignature).toHaveBeenCalledWith({
        xSignature: 'sig',
        xRequestId: 'req',
        dataId: 'pay-1',
      });
      expect(result).toBe(true);
    });
  });
});
