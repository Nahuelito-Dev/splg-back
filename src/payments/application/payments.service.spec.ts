import { OrderStatus, PaymentStatus } from '../../order/entities/order.entity';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { OrderLookupService } from '../../order/lookup/order-lookup.service';
import { In, Repository } from 'typeorm';
import { PaymentsService } from './payments.service';
import { Payment } from '../entities/payment.entity';
import { PaymentGatewayPort } from '../domain/ports/payment-gateway.port';
import { LedgerPaymentStatus } from '../domain/payment.enums';
import { SalesCashService } from '../../cash/application/sales-cash.service';

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
    find: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let orderLookup: { findPaymentState: jest.Mock };
  let ventasEnCaja: {
    asentarCobroDeMercadoPago: jest.Mock;
    asentarDevolucionExterna: jest.Mock;
    avisarSinAsentar: jest.Mock;
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
      find: jest.fn(),
      manager: {
        transaction: jest.fn((trabajo: (m: unknown) => unknown) =>
          trabajo({ getRepository: () => paymentRepository }),
        ),
      },
    };
    paymentGateway = {
      createCheckout: jest.fn(),
      getPayment: jest.fn(),
      verifyWebhookSignature: jest.fn(),
    };

    orderLookup = {
      findPaymentState: jest.fn().mockResolvedValue({
        status: OrderStatus.PENDING,
        paymentStatus: PaymentStatus.PENDING,
      }),
    };

    ventasEnCaja = {
      asentarCobroDeMercadoPago: jest.fn().mockResolvedValue('asentado'),
      asentarDevolucionExterna: jest.fn().mockResolvedValue('asentado'),
      avisarSinAsentar: jest.fn(),
    };

    service = new PaymentsService(
      paymentRepository as unknown as Repository<Payment>,
      paymentGateway as unknown as PaymentGatewayPort,
      orderLookup as unknown as OrderLookupService,
      ventasEnCaja as unknown as SalesCashService,
    );
  });

  describe('createCheckout: pedido que ya no se puede cobrar', () => {
    const input = {
      orderId: 'ord-1',
      amount: 1000,
      isDeposit: false,
      items: [],
      payerEmail: 'c@test.com',
    };

    it.each([
      [
        'pagado',
        { status: OrderStatus.PENDING, paymentStatus: PaymentStatus.PAID },
      ],
      [
        'cancelado',
        { status: OrderStatus.CANCELLED, paymentStatus: PaymentStatus.PENDING },
      ],
      [
        'entregado',
        { status: OrderStatus.DELIVERED, paymentStatus: PaymentStatus.PENDING },
      ],
    ])(
      'un pedido %s es 409 y no deja rastro en el ledger ni llama a la pasarela',
      async (_n, estado) => {
        orderLookup.findPaymentState.mockResolvedValue(estado);
        await expect(service.createCheckout(input)).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(paymentRepository.save).not.toHaveBeenCalled();
        expect(paymentGateway.createCheckout).not.toHaveBeenCalled();
      },
    );

    it('un pedido inexistente es 404', async () => {
      orderLookup.findPaymentState.mockResolvedValue(null);
      await expect(service.createCheckout(input)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('findPendingCheckoutUrls', () => {
    const pago = (orderId: string, status: string, paymentUrl: string | null) =>
      ({ orderId, status, paymentUrl }) as unknown as Payment;

    it('sin ids no consulta', async () => {
      expect((await service.findPendingCheckoutUrls([])).size).toBe(0);
      expect(paymentRepository.find).not.toHaveBeenCalled();
    });

    it('pide todos los intentos de los pedidos, del más viejo al más nuevo, sin filtrar por estado', async () => {
      paymentRepository.find.mockResolvedValue([]);
      await service.findPendingCheckoutUrls(['o1', 'o2']);
      expect(paymentRepository.find).toHaveBeenCalledWith({
        where: { orderId: In(['o1', 'o2']) },
        order: { createdAt: 'ASC' },
      });
    });

    it('publica la URL del último intento si sigue pendiente', async () => {
      paymentRepository.find.mockResolvedValue([
        pago('o1', 'rejected', 'https://mp.test/viejo'),
        pago('o1', 'pending', 'https://mp.test/nuevo'),
      ]);
      const urls = await service.findPendingCheckoutUrls(['o1']);
      expect(urls.get('o1')).toBe('https://mp.test/nuevo');
    });

    it('un intento posterior rechazado, cancelado, pagado o sin URL reemplaza al pendiente: no se publica el viejo', async () => {
      paymentRepository.find.mockResolvedValue([
        pago('o1', 'pending', 'https://mp.test/viejo-1'),
        pago('o1', 'rejected', 'https://mp.test/rechazado'),
        pago('o2', 'pending', 'https://mp.test/viejo-2'),
        pago('o2', 'pending', null),
        pago('o3', 'pending', 'https://mp.test/viejo-3'),
        pago('o3', 'approved', 'https://mp.test/pagado'),
      ]);
      const urls = await service.findPendingCheckoutUrls(['o1', 'o2', 'o3']);
      expect(urls.size).toBe(0);
    });
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

    describe('atomicidad: leer, validar y escribir con la fila bloqueada', () => {
      it('corre en una transacción y lee el pago con FOR UPDATE', async () => {
        paymentGateway.getPayment.mockResolvedValue({
          id: 'pay-1',
          status: 'approved',
          externalReference: 'ord-1',
        });
        paymentRepository.findOne.mockResolvedValueOnce({
          paymentId: 'l1',
          orderId: 'ord-1',
          gatewayPaymentId: 'pay-1',
          amount: 10,
          status: LedgerPaymentStatus.PENDING,
          metadata: null,
        });

        await service.confirmFromGateway({ type: 'payment', dataId: 'pay-1' });

        expect(paymentRepository.manager.transaction).toHaveBeenCalledTimes(1);
        expect(paymentRepository.findOne).toHaveBeenCalledWith(
          expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
        );
      });

      it('con dos intentos sin id de pasarela, si otra notificación ya tomó el otro, usa ése y no choca con el índice único', async () => {
        paymentGateway.getPayment.mockResolvedValue({
          id: 'pay-1',
          status: 'approved',
          externalReference: 'ord-1',
          amount: 10,
        });
        const intentoAnterior = {
          paymentId: 'viejo',
          orderId: 'ord-1',
          gatewayPaymentId: null,
          amount: 10,
          isDeposit: false,
          status: LedgerPaymentStatus.PENDING,
          metadata: null,
        };
        const yaTomado = {
          ...intentoAnterior,
          paymentId: 'nuevo',
          gatewayPaymentId: 'pay-1',
          status: LedgerPaymentStatus.APPROVED,
        };
        paymentRepository.findOne
          .mockResolvedValueOnce(null) // por id de pasarela
          .mockResolvedValueOnce(intentoAnterior) // candidato (IS NULL) tras esperar el lock
          .mockResolvedValueOnce(yaTomado); // se resuelve de nuevo por id de pasarela

        await service.confirmFromGateway({ type: 'payment', dataId: 'pay-1' });

        const guardado = (
          paymentRepository.save.mock.calls as Array<[{ paymentId: string }]>
        )[0][0];
        expect(guardado.paymentId).toBe('nuevo');
        expect(intentoAnterior.gatewayPaymentId).toBeNull();
      });

      it('un 23505 por el id de pasarela no es un error: se reintenta sobre el intento que ya lo tiene', async () => {
        paymentGateway.getPayment.mockResolvedValue({
          id: 'pay-1',
          status: 'approved',
          externalReference: 'ord-1',
        });
        const intento = {
          paymentId: 'a',
          orderId: 'ord-1',
          gatewayPaymentId: null,
          amount: 10,
          isDeposit: false,
          status: LedgerPaymentStatus.PENDING,
          metadata: null,
        };
        paymentRepository.findOne
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(intento)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({
            ...intento,
            gatewayPaymentId: 'pay-1',
            status: LedgerPaymentStatus.APPROVED,
          });
        paymentRepository.save.mockRejectedValueOnce({ code: '23505' });

        const result = await service.confirmFromGateway({
          type: 'payment',
          dataId: 'pay-1',
        });

        expect(result?.status).toBe('approved');
        expect(paymentRepository.manager.transaction).toHaveBeenCalledTimes(2);
      });

      it('si otra notificación del mismo pago se llevó el registro pendiente mientras esperaba el lock, relee por el id de la pasarela', async () => {
        paymentGateway.getPayment.mockResolvedValue({
          id: 'pay-1',
          status: 'pending',
          externalReference: 'ord-1',
        });
        const yaAprobado = {
          paymentId: 'l1',
          orderId: 'ord-1',
          gatewayPaymentId: 'pay-1',
          amount: 10,
          isDeposit: false,
          status: LedgerPaymentStatus.APPROVED,
          metadata: null,
        };
        paymentRepository.findOne
          .mockResolvedValueOnce(null) // por id de pasarela
          .mockResolvedValueOnce(null) // pendiente sin id: ya se lo llevó la otra
          .mockResolvedValueOnce(yaAprobado); // relectura por id de pasarela

        const result = await service.confirmFromGateway({
          type: 'payment',
          dataId: 'pay-1',
        });

        expect(paymentRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({ status: LedgerPaymentStatus.APPROVED }),
        );
        expect(result?.status).toBe('approved');
      });
    });

    describe('el estado del pago no retrocede', () => {
      const ledgerAprobado = () => ({
        paymentId: 'ledger-1',
        orderId: 'ord-1',
        externalReference: 'ord-1',
        gatewayPaymentId: 'pay-1',
        amount: 15000,
        isDeposit: false,
        status: LedgerPaymentStatus.APPROVED,
        metadata: { gatewayStatus: 'approved' },
      });

      it.each(['pending', 'rejected', 'cancelled'])(
        'una notificación atrasada (%s) no pisa un pago aprobado, y se informa como aprobado',
        async (estado) => {
          paymentGateway.getPayment.mockResolvedValue({
            id: 'pay-1',
            status: estado,
            externalReference: 'ord-1',
          });
          paymentRepository.findOne.mockResolvedValueOnce(ledgerAprobado());

          const result = await service.confirmFromGateway({
            type: 'payment',
            dataId: 'pay-1',
          });

          expect(paymentRepository.save).toHaveBeenCalledWith(
            expect.objectContaining({ status: LedgerPaymentStatus.APPROVED }),
          );
          expect(result?.status).toBe('approved');
        },
      );

      it('un pago aprobado sí puede pasar a devuelto', async () => {
        paymentGateway.getPayment.mockResolvedValue({
          id: 'pay-1',
          status: 'refunded',
          externalReference: 'ord-1',
        });
        paymentRepository.findOne.mockResolvedValueOnce(ledgerAprobado());

        const result = await service.confirmFromGateway({
          type: 'payment',
          dataId: 'pay-1',
        });

        expect(paymentRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({ status: LedgerPaymentStatus.REFUNDED }),
        );
        expect(result?.status).toBe('refunded');
      });
    });

    it('la alerta de monto distinto es persistente: un pending atrasado posterior la sigue informando', async () => {
      const ledger = {
        paymentId: 'l1',
        orderId: 'ord-1',
        externalReference: 'ord-1',
        gatewayPaymentId: null as string | null,
        amount: 15000,
        isDeposit: false,
        status: LedgerPaymentStatus.PENDING,
        metadata: null as Record<string, unknown> | null,
      };
      paymentRepository.save.mockImplementation((p: typeof ledger) =>
        Promise.resolve(p),
      );
      // 1) aprobación por un monto distinto
      paymentGateway.getPayment.mockResolvedValueOnce({
        id: 'pay-1',
        status: 'approved',
        externalReference: 'ord-1',
        amount: 1500,
      });
      paymentRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(ledger);
      await service.confirmFromGateway({ type: 'payment', dataId: 'pay-1' });

      // 2) un pending atrasado del mismo pago: el ledger sigue aprobado y marcado
      paymentGateway.getPayment.mockResolvedValueOnce({
        id: 'pay-1',
        status: 'pending',
        externalReference: 'ord-1',
        amount: 15000,
      });
      paymentRepository.findOne.mockResolvedValueOnce(ledger);
      const result = await service.confirmFromGateway({
        type: 'payment',
        dataId: 'pay-1',
      });

      expect(result?.status).toBe('approved');
      expect(result?.montoDistinto).toEqual({ esperado: 15000, cobrado: 1500 });
      expect(ledger.status).toBe(LedgerPaymentStatus.APPROVED);
    });

    describe('el monto aprobado por la pasarela contra el esperado', () => {
      const pendiente = (amount: number) => ({
        paymentId: 'ledger-1',
        orderId: 'ord-1',
        externalReference: 'ord-1',
        gatewayPaymentId: null,
        amount,
        isDeposit: false,
        status: LedgerPaymentStatus.PENDING,
        metadata: null,
      });

      it('si coincide, no hay alerta', async () => {
        paymentGateway.getPayment.mockResolvedValue({
          id: 'pay-1',
          status: 'approved',
          externalReference: 'ord-1',
          amount: 15000,
        });
        paymentRepository.findOne
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(pendiente(15000));

        const result = await service.confirmFromGateway({
          type: 'payment',
          dataId: 'pay-1',
        });

        expect(result?.montoDistinto).toBeUndefined();
      });

      it('si difiere, lo informa para que no se despache y deja el registro en el ledger', async () => {
        paymentGateway.getPayment.mockResolvedValue({
          id: 'pay-1',
          status: 'approved',
          externalReference: 'ord-1',
          amount: 1500,
        });
        paymentRepository.findOne
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(pendiente(15000));

        const result = await service.confirmFromGateway({
          type: 'payment',
          dataId: 'pay-1',
        });

        expect(result?.montoDistinto).toEqual({
          esperado: 15000,
          cobrado: 1500,
        });
        expect(paymentRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({
            status: LedgerPaymentStatus.APPROVED,
            metadata: expect.objectContaining({
              montoDistinto: { esperado: 15000, cobrado: 1500 },
            }) as object,
          }),
        );
      });

      it('si la pasarela no informa el monto, no se puede comparar y sigue como antes', async () => {
        paymentGateway.getPayment.mockResolvedValue({
          id: 'pay-1',
          status: 'approved',
          externalReference: 'ord-1',
          amount: null,
        });
        paymentRepository.findOne
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(pendiente(15000));

        const result = await service.confirmFromGateway({
          type: 'payment',
          dataId: 'pay-1',
        });

        expect(result?.montoDistinto).toBeUndefined();
      });

      it('un pago rechazado no se compara', async () => {
        paymentGateway.getPayment.mockResolvedValue({
          id: 'pay-1',
          status: 'rejected',
          externalReference: 'ord-1',
          amount: 1,
        });
        paymentRepository.findOne
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(pendiente(15000));

        const result = await service.confirmFromGateway({
          type: 'payment',
          dataId: 'pay-1',
        });

        expect(result?.montoDistinto).toBeUndefined();
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

  describe('ingreso a la caja de Mercado Pago', () => {
    const ledger = (over: Record<string, unknown> = {}) => ({
      paymentId: 'ledger-1',
      orderId: 'ord-1',
      distributorId: 'dist-1',
      externalReference: 'ord-1',
      gatewayPaymentId: null,
      isDeposit: false,
      amount: 3000,
      status: LedgerPaymentStatus.PENDING,
      approvedAt: null,
      metadata: null,
      ...over,
    });
    const notificar = (estado: string, extra: Record<string, unknown> = {}) => {
      paymentGateway.getPayment.mockResolvedValue({
        id: 'mp-1',
        status: estado,
        externalReference: 'ord-1',
        amount: 3000,
        feeAmount: 149.5,
        ...extra,
      });
      return service.confirmFromGateway({ type: 'payment', dataId: 'mp-1' });
    };

    it('el pago aprobado entra a la caja en la misma transacción, con el importe cobrado y la comisión', async () => {
      paymentRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(ledger());

      await notificar('approved');

      expect(ventasEnCaja.asentarCobroDeMercadoPago).toHaveBeenCalledTimes(1);
      expect(ventasEnCaja.asentarCobroDeMercadoPago).toHaveBeenCalledWith(
        expect.anything(),
        {
          distributorId: 'dist-1',
          orderId: 'ord-1',
          paymentId: 'ledger-1',
          gatewayPaymentId: 'mp-1',
          amount: 3000,
          feeAmount: 149.5,
          feeUnreported: false,
        },
      );
      expect(paymentRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          approvedAt: expect.any(Date) as Date,
          metadata: expect.objectContaining({
            gatewayAmount: 3000,
            feeAmount: 149.5,
          }) as Record<string, unknown>,
        }),
      );
    });

    it('si la pasarela no informa la comisión, el cobro entra marcado y el pago guarda que falta', async () => {
      paymentRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(ledger());

      await notificar('approved', { feeAmount: null });

      expect(ventasEnCaja.asentarCobroDeMercadoPago).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ feeAmount: null, feeUnreported: true }),
      );
      expect(paymentRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            feeStatus: 'unreported',
          }) as Record<string, unknown>,
        }),
      );
    });

    describe('devolución hecha por Mercado Pago por su cuenta', () => {
      const aprobado = () =>
        ledger({
          gatewayPaymentId: 'mp-1',
          status: LedgerPaymentStatus.APPROVED,
          approvedAt: new Date(),
          metadata: { gatewayStatus: 'approved', gatewayRefunded: 500 },
        });

      it('una devolución parcial que sube asienta lo devuelto en total y lo guarda', async () => {
        paymentRepository.findOne.mockResolvedValueOnce(aprobado());

        await notificar('approved', { refundedAmount: 1200 });

        expect(ventasEnCaja.asentarCobroDeMercadoPago).not.toHaveBeenCalled();
        expect(ventasEnCaja.asentarDevolucionExterna).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            paymentId: 'ledger-1',
            refundedTotal: 1200,
            contracargo: false,
          }),
        );
        expect(paymentRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({
            metadata: expect.objectContaining({
              gatewayRefunded: 1200,
            }) as Record<string, unknown>,
          }),
        );
      });

      it('un pago devuelto por completo sin importe informado devuelve todo lo cobrado', async () => {
        paymentRepository.findOne.mockResolvedValueOnce(aprobado());

        await notificar('refunded', { refundedAmount: null });

        expect(ventasEnCaja.asentarDevolucionExterna).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ refundedTotal: 3000, contracargo: false }),
        );
      });

      it('un contracargo se asienta como tal', async () => {
        paymentRepository.findOne.mockResolvedValueOnce(aprobado());

        await notificar('charged_back', { refundedAmount: null });

        expect(ventasEnCaja.asentarDevolucionExterna).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ refundedTotal: 3000, contracargo: true }),
        );
      });

      it('sin devolución en la pasarela no se mueve la caja', async () => {
        paymentRepository.findOne.mockResolvedValueOnce(aprobado());

        await notificar('approved', { refundedAmount: 0 });

        expect(ventasEnCaja.asentarDevolucionExterna).not.toHaveBeenCalled();
      });

      it('si la caja no pudo asentarla, la confirmación sigue y se avisa', async () => {
        ventasEnCaja.asentarDevolucionExterna.mockResolvedValue('fallo');
        paymentRepository.findOne.mockResolvedValueOnce(aprobado());

        await notificar('approved', { refundedAmount: 1200 });

        expect(ventasEnCaja.avisarSinAsentar).toHaveBeenCalledWith(
          'dist-1',
          'fallo',
          'ord-1',
        );
      });
    });

    it('asienta lo que la pasarela cobró de verdad, aunque difiera de lo esperado', async () => {
      paymentRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(ledger());

      await notificar('approved', { amount: 2500 });

      expect(ventasEnCaja.asentarCobroDeMercadoPago).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ amount: 2500 }),
      );
    });

    it('un webhook repetido del pago ya aprobado no vuelve a asentar', async () => {
      paymentRepository.findOne.mockResolvedValueOnce(
        ledger({
          gatewayPaymentId: 'mp-1',
          status: LedgerPaymentStatus.APPROVED,
          approvedAt: new Date(),
        }),
      );

      await notificar('approved');

      expect(ventasEnCaja.asentarCobroDeMercadoPago).not.toHaveBeenCalled();
    });

    it.each(['rejected', 'pending', 'cancelled'])(
      'un pago %s no mueve la caja',
      async (estado) => {
        paymentRepository.findOne
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(ledger());

        await notificar(estado);

        expect(ventasEnCaja.asentarCobroDeMercadoPago).not.toHaveBeenCalled();
      },
    );

    it('si no hay caja configurada la confirmación sigue y se avisa al administrador', async () => {
      ventasEnCaja.asentarCobroDeMercadoPago.mockResolvedValue('sin_caja');
      paymentRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(ledger());

      const resultado = await notificar('approved');

      expect(resultado?.status).toBe('approved');
      expect(ventasEnCaja.avisarSinAsentar).toHaveBeenCalledWith(
        'dist-1',
        'sin_caja',
        'ord-1',
      );
    });

    it('un pago sin distribuidora en el ledger se aprueba sin asentar', async () => {
      paymentRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(ledger({ distributorId: null }));

      const resultado = await notificar('approved');

      expect(resultado?.status).toBe('approved');
      expect(ventasEnCaja.asentarCobroDeMercadoPago).not.toHaveBeenCalled();
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
