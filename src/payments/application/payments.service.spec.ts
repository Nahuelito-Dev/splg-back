import { OrderStatus, PaymentStatus } from '../../order/entities/order.entity';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { OrderLookupService } from '../../order/lookup/order-lookup.service';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FindOperator, In, Repository } from 'typeorm';
import { PaymentsService } from './payments.service';
import { Payment } from '../entities/payment.entity';
import { PaymentGatewayPort } from '../domain/ports/payment-gateway.port';
import {
  LedgerPaymentStatus,
  OrigenDelEstadoDelPago,
} from '../domain/payment.enums';
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
    count: jest.Mock;
    manager: { transaction: jest.Mock; findOne: jest.Mock };
  };
  let orderLookup: { findPaymentState: jest.Mock };
  let events: { emit: jest.Mock };
  let ventasEnCaja: {
    asentarCobroDeMercadoPago: jest.Mock;
    asentarDevolucionExterna: jest.Mock;
    asentarContracargoReintegrado: jest.Mock;
    avisarSinAsentar: jest.Mock;
  };
  let paymentGateway: {
    createCheckout: jest.Mock;
    getPayment: jest.Mock;
    findPaymentsByReference: jest.Mock;
    getChargeback: jest.Mock;
    verifyWebhookSignature: jest.Mock;
  };

  beforeEach(() => {
    paymentRepository = {
      create: jest.fn((data: Partial<Payment>) => ({ ...data })),
      save: jest.fn((entity: Payment) => Promise.resolve(entity)),
      findOne: jest.fn(),
      find: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      manager: {
        transaction: jest.fn((trabajo: (m: unknown) => unknown) =>
          trabajo({ getRepository: () => paymentRepository }),
        ),
        findOne: jest.fn().mockResolvedValue({ name: 'Gas del Litoral' }),
      },
    };
    paymentGateway = {
      createCheckout: jest.fn(),
      getPayment: jest.fn(),
      findPaymentsByReference: jest.fn(),
      getChargeback: jest.fn(),
      verifyWebhookSignature: jest.fn(),
    };

    events = { emit: jest.fn() };
    orderLookup = {
      findPaymentState: jest.fn().mockResolvedValue({
        status: OrderStatus.PENDING,
        paymentStatus: PaymentStatus.PENDING,
        createdAt: new Date(),
        distributorId: 'dist-1',
      }),
    };

    ventasEnCaja = {
      asentarCobroDeMercadoPago: jest.fn().mockResolvedValue('asentado'),
      asentarDevolucionExterna: jest.fn().mockResolvedValue('asentado'),
      asentarContracargoReintegrado: jest.fn().mockResolvedValue('asentado'),
      avisarSinAsentar: jest.fn(),
    };

    service = new PaymentsService(
      paymentRepository as unknown as Repository<Payment>,
      paymentGateway as unknown as PaymentGatewayPort,
      orderLookup as unknown as OrderLookupService,
      ventasEnCaja as unknown as SalesCashService,
      {
        getOrThrow: (clave: string) =>
          clave === 'RESERVATION_DEPOSIT_TTL_HOURS' ? 48 : 60,
      } as unknown as ConfigService,
      events as unknown as EventEmitter2,
    );
  });

  describe('createCheckout: pedido que ya no se puede cobrar', () => {
    const input = {
      orderId: 'ord-1',
      amount: 1000,
      isDeposit: false,
      items: [],
      payer: { email: 'c@test.com' },
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

  describe('createCheckout: datos para la pasarela', () => {
    const input = {
      orderId: 'ord-1',
      distributorId: 'dist-1',
      amount: 2000,
      isDeposit: false,
      items: [],
      payer: { email: 'c@test.com', fullName: 'Ana Pérez' },
      receiverAddress: { street: 'Av. Colón 1234' },
    };

    beforeEach(() => {
      paymentGateway.createCheckout.mockResolvedValue({
        initPoint: 'https://mp.test/checkout',
        preferenceId: 'pref-1',
        credentialId: null,
      });
    });

    const enviado = () =>
      (
        paymentGateway.createCheckout.mock.calls as [Record<string, unknown>][]
      )[0][0];

    it('le pasa a la pasarela el pagador y la dirección de entrega', async () => {
      await service.createCheckout(input);

      expect(enviado().payer).toEqual(input.payer);
      expect(enviado().receiverAddress).toEqual(input.receiverAddress);
    });

    it('el descriptor del resumen es el nombre de la distribuidora, sin tildes ni símbolos y de hasta 13', async () => {
      paymentRepository.manager.findOne.mockResolvedValue({
        name: 'Distribuidora Ñandú & Hijos S.R.L.',
      });

      await service.createCheckout(input);

      expect(enviado().statementDescriptor).toBe('DISTRIBUIDORA');
    });

    it('sin nombre legible, o si no se lo puede leer, el descriptor es SPLG', async () => {
      paymentRepository.manager.findOne.mockResolvedValue({ name: '***' });
      await service.createCheckout(input);
      expect(enviado().statementDescriptor).toBe('SPLG');

      paymentGateway.createCheckout.mockClear();
      paymentRepository.manager.findOne.mockRejectedValue(new Error('base'));
      await service.createCheckout(input);
      expect(enviado().statementDescriptor).toBe('SPLG');
    });
  });

  describe('pago en reclamo (in_mediation)', () => {
    const ledger = (
      estado: LedgerPaymentStatus,
      metadata: Record<string, unknown> | null = null,
    ) => ({
      paymentId: 'ledger-1',
      orderId: 'ord-1',
      distributorId: 'dist-1',
      externalReference: 'ord-1',
      gatewayPaymentId: 'pay-1',
      isDeposit: false,
      amount: 1000,
      credentialId: null,
      status: estado,
      statusDetail: 'accredited' as string | null,
      statusHistory: [] as unknown[],
      metadata,
    });
    const avisos = () =>
      (events.emit.mock.calls as [string, { kind: string }][]).map(
        ([, e]) => e.kind,
      );

    beforeEach(() => {
      paymentGateway.getPayment.mockResolvedValue({
        id: 'pay-1',
        status: 'in_mediation',
        statusDetail: 'pending',
        externalReference: 'ord-1',
        amount: 1000,
      });
    });

    it('un reclamo sobre un pago aprobado pasa el ledger a in_mediation y avisa al admin', async () => {
      const pago = ledger(LedgerPaymentStatus.APPROVED, {
        gatewayStatus: 'approved',
      });
      paymentRepository.findOne.mockResolvedValueOnce(pago);

      const r = await service.confirmFromGateway({
        type: 'payment',
        dataId: 'pay-1',
      });

      expect(pago.status).toBe(LedgerPaymentStatus.IN_MEDIATION);
      expect(pago.statusDetail).toBe('pending');
      expect(r?.status).toBe('in_mediation');
      expect(avisos()).toEqual(['payment_in_mediation']);
      expect((events.emit.mock.calls as unknown[][])[0][1]).toMatchObject({
        distributorId: 'dist-1',
        dedupeKey: 'mp-mediacion:pay-1',
      });
    });

    it('una segunda notificación del mismo reclamo no vuelve a avisar', async () => {
      paymentRepository.findOne.mockResolvedValueOnce(
        ledger(LedgerPaymentStatus.IN_MEDIATION),
      );

      await service.confirmFromGateway({ type: 'payment', dataId: 'pay-1' });

      expect(events.emit).not.toHaveBeenCalled();
    });

    it.each([
      ['approved', LedgerPaymentStatus.APPROVED],
      ['refunded', LedgerPaymentStatus.REFUNDED],
      ['charged_back', LedgerPaymentStatus.CHARGED_BACK],
    ])(
      'cuando el reclamo se resuelve (%s) el ledger sale de in_mediation',
      async (estadoDeMp, esperado) => {
        const pago = ledger(LedgerPaymentStatus.IN_MEDIATION);
        paymentRepository.findOne.mockResolvedValueOnce(pago);
        paymentGateway.getPayment.mockResolvedValue({
          id: 'pay-1',
          status: estadoDeMp,
          externalReference: 'ord-1',
          amount: 1000,
        });

        await service.confirmFromGateway({ type: 'payment', dataId: 'pay-1' });

        expect(pago.status).toBe(esperado);
      },
    );

    it('si el aviso de la aprobación no llegó, un reclamo sobre un pago pendiente acredita el cobro (caja) y lo deja en reclamo', async () => {
      const pago = ledger(LedgerPaymentStatus.PENDING);
      paymentRepository.findOne.mockResolvedValueOnce(pago);

      await service.confirmFromGateway({ type: 'payment', dataId: 'pay-1' });

      expect(pago.status).toBe(LedgerPaymentStatus.IN_MEDIATION);
      expect(ventasEnCaja.asentarCobroDeMercadoPago).toHaveBeenCalledTimes(1);
    });
  });

  describe('contracargos', () => {
    const contracargo = {
      id: 'cb-1',
      paymentIds: ['pay-1'],
      amount: 1000,
      documentationRequired: true,
      documentationDeadline: '2026-11-10T00:00:00.000-03:00',
    };
    const pagoDelLedger = () => ({
      paymentId: 'ledger-1',
      orderId: 'ord-1',
      distributorId: 'dist-1',
      gatewayPaymentId: 'pay-1',
      externalReference: 'ord-1',
      isDeposit: false,
      amount: 1000,
      credentialId: null,
      status: LedgerPaymentStatus.APPROVED,
      statusDetail: 'accredited' as string | null,
      statusHistory: [] as unknown[],
      metadata: { gatewayStatus: 'approved' } as Record<string, unknown>,
    });

    it.each(['topic_chargebacks_wh', 'chargebacks'])(
      'el tópico %s consulta el contracargo, lo marca en el pago y avisa al admin con el plazo',
      async (type) => {
        paymentGateway.getChargeback.mockResolvedValue(contracargo);
        const pago = pagoDelLedger();
        paymentRepository.findOne
          .mockResolvedValueOnce(pago)
          .mockResolvedValueOnce(pago);
        paymentGateway.getPayment.mockResolvedValue({
          id: 'pay-1',
          status: 'approved',
          externalReference: 'ord-1',
          amount: 1000,
        });

        const r = await service.confirmFromGateway({
          type,
          dataId: 'cb-1',
          credentialId: 'cred-1',
        });

        expect(r).toBeNull();
        expect(paymentGateway.getChargeback).toHaveBeenCalledWith(
          'cb-1',
          'cred-1',
        );
        expect(pago.metadata).toMatchObject({
          gatewayStatus: 'approved',
          chargeback: {
            id: 'cb-1',
            amount: 1000,
            documentationRequired: true,
          },
        });
        const [evento, aviso] = events.emit.mock.calls[0] as [
          string,
          Record<string, string>,
        ];
        expect(evento).toBe('admin.notificar');
        expect(aviso).toMatchObject({
          distributorId: 'dist-1',
          kind: 'payment_chargeback_opened',
          dedupeKey: 'mp-contracargo-abierto:cb-1:pay-1',
        });
        expect(aviso.body).toContain('2026-11-10');
        expect(aviso.body).toContain('comprobante de entrega');
      },
    );

    it('si Mercado Pago no responde al consultar el contracargo LANZA: el webhook da 503 y MP reintenta', async () => {
      paymentGateway.getChargeback.mockRejectedValue(new Error('timeout'));

      await expect(
        service.confirmFromGateway({
          type: 'topic_chargebacks_wh',
          dataId: 'cb-1',
        }),
      ).rejects.toThrow('timeout');
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('un contracargo que Mercado Pago no conoce (404) se descarta', async () => {
      paymentGateway.getChargeback.mockRejectedValue({ status: 404 });

      await expect(
        service.confirmFromGateway({
          type: 'topic_chargebacks_wh',
          dataId: 'cb-1',
        }),
      ).resolves.toBeNull();
    });

    it('si falla guardar la marca del contracargo en el pago LANZA (503 y reintento), no se pierde', async () => {
      paymentGateway.getChargeback.mockResolvedValue(contracargo);
      paymentRepository.manager.transaction.mockRejectedValueOnce(
        new Error('base caída'),
      );

      await expect(
        service.confirmFromGateway({
          type: 'topic_chargebacks_wh',
          dataId: 'cb-1',
        }),
      ).rejects.toThrow('base caída');
    });

    it('alinea el pago con lo que dice la pasarela: charged_back pasa el ledger y asienta el egreso', async () => {
      paymentGateway.getChargeback.mockResolvedValue(contracargo);
      const pago = {
        ...pagoDelLedger(),
        status: LedgerPaymentStatus.APPROVED,
        statusDetail: 'accredited',
        statusHistory: [],
        externalReference: 'ord-1',
        isDeposit: false,
        amount: 1000,
        credentialId: null,
      };
      paymentRepository.findOne
        .mockResolvedValueOnce(pago)
        .mockResolvedValueOnce(pago);
      paymentGateway.getPayment.mockResolvedValue({
        id: 'pay-1',
        status: 'charged_back',
        statusDetail: 'settled',
        externalReference: 'ord-1',
        amount: 1000,
      });

      await service.confirmFromGateway({
        type: 'topic_chargebacks_wh',
        dataId: 'cb-1',
      });

      expect(pago.status).toBe(LedgerPaymentStatus.CHARGED_BACK);
      expect(ventasEnCaja.asentarDevolucionExterna).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ contracargo: true, refundedTotal: 1000 }),
      );
    });

    it('un pago que no está en el ledger no avisa', async () => {
      paymentGateway.getChargeback.mockResolvedValue(contracargo);
      paymentRepository.findOne.mockResolvedValueOnce(null);

      await service.confirmFromGateway({
        type: 'topic_chargebacks_wh',
        dataId: 'cb-1',
      });

      expect(events.emit).not.toHaveBeenCalled();
    });

    it('sin distribuidora en el pago usa la del pedido', async () => {
      paymentGateway.getChargeback.mockResolvedValue(contracargo);
      const sinDistribuidora = { ...pagoDelLedger(), distributorId: null };
      paymentRepository.findOne
        .mockResolvedValueOnce(sinDistribuidora)
        .mockResolvedValueOnce(sinDistribuidora);
      paymentGateway.getPayment.mockResolvedValue({
        id: 'pay-1',
        status: 'approved',
        externalReference: 'ord-1',
        amount: 1000,
      });

      await service.confirmFromGateway({
        type: 'topic_chargebacks_wh',
        dataId: 'cb-1',
      });

      expect((events.emit.mock.calls as unknown[][])[0][1]).toMatchObject({
        distributorId: 'dist-1',
      });
    });
  });

  describe('findPendingCheckoutUrls', () => {
    const enUnaHora = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const hace1h = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const pago = (
      orderId: string,
      status: string,
      paymentUrl: string | null,
      extra: Record<string, unknown> = {},
    ) =>
      ({
        orderId,
        status,
        paymentUrl,
        gatewayPaymentId: null,
        isDeposit: false,
        createdAt: new Date(),
        metadata: { expiresAt: enUnaHora },
        ...extra,
      }) as unknown as Payment;

    it('sin ids no consulta', async () => {
      expect((await service.findPendingCheckoutUrls([])).size).toBe(0);
      expect(paymentRepository.find).not.toHaveBeenCalled();
    });

    it('pide los intentos de Mercado Pago de los pedidos, del más viejo al más nuevo, sin filtrar por estado', async () => {
      paymentRepository.find.mockResolvedValue([]);
      await service.findPendingCheckoutUrls(['o1', 'o2']);
      expect(paymentRepository.find).toHaveBeenCalledWith({
        where: { orderId: In(['o1', 'o2']), gateway: 'mercadopago' },
        order: { createdAt: 'ASC' },
      });
    });

    it('publica la URL del intento pendiente', async () => {
      paymentRepository.find.mockResolvedValue([
        pago('o1', 'rejected', 'https://mp.test/viejo'),
        pago('o1', 'pending', 'https://mp.test/nuevo'),
      ]);
      const urls = await service.findPendingCheckoutUrls(['o1']);
      expect(urls.get('o1')).toBe('https://mp.test/nuevo');
    });

    it('un rechazo o cancelación con el checkout sin vencer deja reintentar con el mismo enlace', async () => {
      paymentRepository.find.mockResolvedValue([
        pago('o1', 'rejected', 'https://mp.test/o1'),
        pago('o2', 'cancelled', 'https://mp.test/o2'),
      ]);
      const urls = await service.findPendingCheckoutUrls(['o1', 'o2']);
      expect(urls.get('o1')).toBe('https://mp.test/o1');
      expect(urls.get('o2')).toBe('https://mp.test/o2');
    });

    it('con el checkout vencido no se publica el enlace (ni rechazado ni pendiente)', async () => {
      paymentRepository.find.mockResolvedValue([
        pago('o1', 'rejected', 'https://mp.test/o1', {
          metadata: { expiresAt: hace1h },
        }),
        pago('o2', 'pending', 'https://mp.test/o2', {
          metadata: { expiresAt: hace1h },
        }),
      ]);
      expect((await service.findPendingCheckoutUrls(['o1', 'o2'])).size).toBe(
        0,
      );
    });

    it.each([
      'in_process',
      'authorized',
      'approved',
      'in_mediation',
      'refunded',
      'charged_back',
    ])(
      'un pago %s: no hay enlace para reintentar (se esperaría un segundo cobro)',
      async (estado) => {
        paymentRepository.find.mockResolvedValue([
          pago('o1', 'rejected', 'https://mp.test/viejo'),
          pago('o1', estado, 'https://mp.test/o1', {
            gatewayPaymentId: 'pay-1',
          }),
        ]);
        expect((await service.findPendingCheckoutUrls(['o1'])).size).toBe(0);
      },
    );

    it('un pendiente que ya tiene pago de la pasarela (transferencia, a la espera) no publica otro enlace', async () => {
      paymentRepository.find.mockResolvedValue([
        pago('o1', 'pending', 'https://mp.test/o1', {
          gatewayPaymentId: 'pay-1',
        }),
      ]);
      expect((await service.findPendingCheckoutUrls(['o1'])).size).toBe(0);
    });

    it('un pago duplicado devuelto no tapa al que quedó cobrado: sin enlace', async () => {
      paymentRepository.find.mockResolvedValue([
        pago('o1', 'approved', 'https://mp.test/o1', {
          gatewayPaymentId: 'pay-1',
        }),
        pago('o1', 'refunded', 'https://mp.test/o1', {
          gatewayPaymentId: 'pay-2',
        }),
      ]);
      expect((await service.findPendingCheckoutUrls(['o1'])).size).toBe(0);
    });

    it('un intento sin URL no publica nada', async () => {
      paymentRepository.find.mockResolvedValue([pago('o2', 'pending', null)]);
      expect((await service.findPendingCheckoutUrls(['o2'])).size).toBe(0);
    });
  });

  describe('createCheckout', () => {
    it('crea el registro de ledger PENDING, delega en la pasarela y completa payment_url/preferenceId', async () => {
      paymentGateway.createCheckout.mockResolvedValue({
        initPoint: 'https://mp.test/checkout',
        preferenceId: 'pref-1',
        credentialId: 'cred-1',
      });

      const result = await service.createCheckout({
        orderId: 'ord-1',
        distributorId: 'dist-1',
        amount: 2000,
        isDeposit: false,
        items: [
          { id: 'gc-1', title: 'Garrafa 10kg', quantity: 2, unitPrice: 1000 },
        ],
        payer: { email: 'cliente@test.com' },
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
        payer: { email: 'cliente@test.com' },
        statementDescriptor: 'GAS DEL LITOR',
        distributorId: 'dist-1',
        expiresAt: expect.any(Date) as Date,
      });

      // Se guarda dos veces: al crear el PENDING y al completar payment_url.
      expect(paymentRepository.save).toHaveBeenCalledTimes(2);
      const lastSaved = (
        paymentRepository.save.mock.calls as Payment[][]
      )[1][0];
      expect(lastSaved.paymentUrl).toBe('https://mp.test/checkout');
      expect(lastSaved.credentialId).toBe('cred-1');
      expect(lastSaved.metadata).toEqual({
        preferenceId: 'pref-1',
        expiresAt: expect.any(String) as string,
      });

      expect(result).toEqual({
        initPoint: 'https://mp.test/checkout',
        preferenceId: 'pref-1',
        credentialId: 'cred-1',
      });
    });

    describe('vencimiento del enlace de pago', () => {
      const cobrar = async (
        isDeposit: boolean,
        creado: Date,
      ): Promise<Date> => {
        orderLookup.findPaymentState.mockResolvedValue({
          status: OrderStatus.PENDING,
          paymentStatus: PaymentStatus.PENDING,
          createdAt: creado,
        });
        paymentGateway.createCheckout.mockResolvedValue({
          initPoint: 'https://mp.test/c',
          preferenceId: 'pref',
          credentialId: null,
        });
        await service.createCheckout({
          orderId: 'ord-1',
          amount: 100,
          isDeposit,
          items: [],
          payer: { email: 'c@test.com' },
        });
        const [pedido] = paymentGateway.createCheckout.mock.calls[0] as [
          { expiresAt: Date },
        ];
        return pedido.expiresAt;
      };

      it('un pedido normal vence a los minutos de espera del pago online, contados desde que se creó', async () => {
        const creado = new Date(Date.now() - 10 * 60 * 1000);
        const vence = await cobrar(false, creado);
        expect(vence.getTime()).toBe(creado.getTime() + 60 * 60 * 1000);
      });

      it('la seña de una reserva vence a las horas de espera de la seña', async () => {
        const creado = new Date(Date.now() - 60 * 60 * 1000);
        const vence = await cobrar(true, creado);
        expect(vence.getTime()).toBe(creado.getTime() + 48 * 3600 * 1000);
      });

      it('si el plazo ya pasó, deja al menos un minuto: Mercado Pago no acepta un vencimiento pasado', async () => {
        const antes = Date.now();
        const vence = await cobrar(false, new Date(antes - 5 * 3600 * 1000));
        expect(vence.getTime()).toBeGreaterThanOrEqual(antes + 60 * 1000);
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
        payer: { email: 'cliente@test.com' },
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
          payer: { email: 'cliente@test.com' },
        }),
      ).rejects.toThrow('MP caído');

      // Solo el save del alta (PENDING); nunca se llegó a completar payment_url.
      expect(paymentRepository.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('consultarPagosDelPedido', () => {
    it('consulta cada cuenta con la que se armó un checkout del pedido y descarta pagos de otro pedido', async () => {
      paymentRepository.find.mockResolvedValue([
        { credentialId: 'cred-1' },
        { credentialId: 'cred-1' },
        { credentialId: null },
      ]);
      paymentGateway.findPaymentsByReference.mockImplementation(
        (_ref: string, cred: string | null) =>
          Promise.resolve([
            {
              id: cred ?? 'sis',
              status: 'approved',
              externalReference: 'ord-1',
            },
            { id: 'ajeno', status: 'approved', externalReference: 'otro' },
          ]),
      );

      const pagos = await service.consultarPagosDelPedido('ord-1');

      expect(paymentGateway.findPaymentsByReference).toHaveBeenCalledTimes(2);
      expect(pagos).toEqual([
        {
          gatewayPaymentId: 'cred-1',
          status: 'approved',
          credentialId: 'cred-1',
        },
        { gatewayPaymentId: 'sis', status: 'approved', credentialId: null },
      ]);
    });

    it('sin intentos en el ledger consulta la cuenta del sistema', async () => {
      paymentRepository.find.mockResolvedValue([]);
      paymentGateway.findPaymentsByReference.mockResolvedValue([]);

      await service.consultarPagosDelPedido('ord-1');

      expect(paymentGateway.findPaymentsByReference).toHaveBeenCalledWith(
        'ord-1',
        null,
      );
    });

    it('si la pasarela no responde lanza (no es «sin pagos»)', async () => {
      paymentRepository.find.mockResolvedValue([]);
      paymentGateway.findPaymentsByReference.mockRejectedValue(
        new Error('timeout'),
      );

      await expect(service.consultarPagosDelPedido('ord-1')).rejects.toThrow(
        'timeout',
      );
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

    it('la consulta a la pasarela falla: lanza para que el webhook responda 5xx y MP reintente', async () => {
      paymentGateway.getPayment.mockRejectedValue(new Error('timeout'));

      await expect(
        service.confirmFromGateway({ type: 'payment', dataId: 'pay-1' }),
      ).rejects.toThrow('timeout');
      expect(paymentRepository.save).not.toHaveBeenCalled();
    });

    it('un pago que la pasarela no conoce (404) no se reintenta: se descarta', async () => {
      paymentGateway.getPayment.mockRejectedValue({
        status: 404,
        message: 'Payment not found',
      });

      await expect(
        service.confirmFromGateway({ type: 'payment', dataId: '123456' }),
      ).resolves.toBeNull();
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

    it('consulta el pago con la cuenta de la notificación', async () => {
      paymentGateway.getPayment.mockResolvedValue({
        id: 'pay-1',
        status: 'approved',
        externalReference: null,
      });

      await service.confirmFromGateway({
        type: 'payment',
        dataId: 'pay-1',
        credentialId: 'cred-1',
      });

      expect(paymentGateway.getPayment).toHaveBeenCalledWith('pay-1', 'cred-1');
    });

    describe('la cuenta de Mercado Pago tiene que ser la del intento de cobro', () => {
      const aprobado = {
        id: 'pay-1',
        status: 'approved',
        externalReference: 'ord-B',
      };
      const ledgerDe = (credentialId: string | null) => ({
        paymentId: 'ledger-B',
        orderId: 'ord-B',
        distributorId: 'dist-B',
        credentialId,
        externalReference: 'ord-B',
        gatewayPaymentId: null,
        isDeposit: false,
        amount: 1000,
        status: LedgerPaymentStatus.PENDING,
        metadata: null,
      });

      it('un aviso de la cuenta de A contra el pedido de B (cobra con la del sistema) no toca nada', async () => {
        paymentGateway.getPayment.mockResolvedValue({
          ...aprobado,
          accountDistributorId: 'dist-A',
        });
        paymentRepository.findOne
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(ledgerDe(null));

        const r = await service.confirmFromGateway({
          type: 'payment',
          dataId: 'pay-1',
          credentialId: 'cred-A',
        });

        expect(r).toBeNull();
        expect(paymentRepository.save).not.toHaveBeenCalled();
        expect(ventasEnCaja.asentarCobroDeMercadoPago).not.toHaveBeenCalled();
      });

      it('un aviso de la cuenta de A contra el pedido de B (cuenta propia de B) no toca nada', async () => {
        paymentGateway.getPayment.mockResolvedValue(aprobado);
        paymentRepository.findOne
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(ledgerDe('cred-B'));

        expect(
          await service.confirmFromGateway({
            type: 'payment',
            dataId: 'pay-1',
            credentialId: 'cred-A',
          }),
        ).toBeNull();
        expect(paymentRepository.save).not.toHaveBeenCalled();
      });

      it('un aviso de la cuenta del sistema contra un pedido que cobra con cuenta propia no toca nada', async () => {
        paymentGateway.getPayment.mockResolvedValue(aprobado);
        paymentRepository.findOne
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(ledgerDe('cred-B'));

        expect(
          await service.confirmFromGateway({
            type: 'payment',
            dataId: 'pay-1',
          }),
        ).toBeNull();
        expect(paymentRepository.save).not.toHaveBeenCalled();
      });

      it('un aviso de una cuenta propia sin ningún intento de cobro tampoco confirma nada', async () => {
        paymentGateway.getPayment.mockResolvedValue(aprobado);
        paymentRepository.findOne.mockResolvedValue(null);

        expect(
          await service.confirmFromGateway({
            type: 'payment',
            dataId: 'pay-1',
            credentialId: 'cred-A',
          }),
        ).toBeNull();
      });

      it('con la cuenta correcta (aunque ya esté desactivada) el pago se aplica', async () => {
        paymentGateway.getPayment.mockResolvedValue(aprobado);
        paymentRepository.findOne
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(ledgerDe('cred-B'));

        const r = await service.confirmFromGateway({
          type: 'payment',
          dataId: 'pay-1',
          credentialId: 'cred-B',
        });

        expect(r).toMatchObject({
          externalReference: 'ord-B',
          status: 'approved',
        });
        expect(paymentRepository.save).toHaveBeenCalled();
      });
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

        await notificar('charged_back', {
          refundedAmount: null,
          statusDetail: 'settled',
        });

        expect(ventasEnCaja.asentarDevolucionExterna).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ refundedTotal: 3000, contracargo: true }),
        );
      });

      it('la devolución que pasa el pago a devuelto se informa como externa (con contracargo si lo es)', async () => {
        paymentRepository.findOne.mockResolvedValueOnce(aprobado());
        const devuelto = await notificar('refunded', { refundedAmount: null });
        expect(devuelto?.devolucionExterna).toEqual({ contracargo: false });

        paymentRepository.findOne.mockResolvedValueOnce(aprobado());
        const contracargo = await notificar('charged_back', {
          refundedAmount: null,
        });
        expect(contracargo?.devolucionExterna).toEqual({ contracargo: true });
      });

      it('si el sistema ya lo había devuelto (ledger devuelto) o sólo hay devolución parcial, no se informa', async () => {
        paymentRepository.findOne.mockResolvedValueOnce(
          ledger({
            gatewayPaymentId: 'mp-1',
            status: LedgerPaymentStatus.REFUNDED,
          }),
        );
        const propia = await notificar('refunded', { refundedAmount: null });
        expect(propia?.devolucionExterna).toBeUndefined();

        paymentRepository.findOne.mockResolvedValueOnce(aprobado());
        const parcial = await notificar('approved', { refundedAmount: 1200 });
        expect(parcial?.devolucionExterna).toBeUndefined();
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

  describe('un pago nuevo del mismo checkout (reintento tras un rechazo, tarjeta tras un ticket)', () => {
    const intento = (over: Record<string, unknown> = {}) => ({
      paymentId: 'ledger-1',
      orderId: 'ord-1',
      distributorId: 'dist-1',
      gateway: 'mercadopago',
      integration: 'checkout_pro',
      externalReference: 'ord-1',
      credentialId: null,
      gatewayPaymentId: 'mp-0',
      isDeposit: false,
      amount: 3000,
      paymentUrl: 'https://mp.test/pref-1',
      status: LedgerPaymentStatus.REJECTED,
      approvedAt: null,
      metadata: { preferenceId: 'pref-1', gatewayStatus: 'rejected' },
      ...over,
    });
    /** Ningún intento tiene el id del pago ni queda uno libre: sólo existe el previo. */
    const soloElPrevio = (previo: object | null) => {
      paymentRepository.findOne
        .mockResolvedValueOnce(null) // por id de pasarela
        .mockResolvedValueOnce(null) // intento libre
        .mockResolvedValueOnce(null) // por id, con el libre bloqueado
        .mockResolvedValueOnce(previo) // intento previo del pedido
        .mockResolvedValueOnce(null); // por id, con el previo bloqueado
      paymentRepository.save.mockImplementation((e: Record<string, unknown>) =>
        Promise.resolve({ paymentId: 'ledger-2', ...e }),
      );
    };
    const pagoNuevo = (
      over: Record<string, unknown> = {},
      credentialId?: string,
    ) => {
      paymentGateway.getPayment.mockResolvedValue({
        id: 'mp-2',
        status: 'approved',
        externalReference: 'ord-1',
        amount: 3000,
        feeAmount: 100,
        ...over,
      });
      return service.confirmFromGateway({
        type: 'payment',
        dataId: 'mp-2',
        credentialId,
      });
    };

    it.each([
      ['rechazo y reintento aprobado', LedgerPaymentStatus.REJECTED],
      ['ticket pendiente y pago con tarjeta', LedgerPaymentStatus.PENDING],
    ])(
      '%s: abre un intento nuevo con la cuenta, el monto y la preferencia del anterior, lo aprueba y lo asienta en caja',
      async (_caso, estadoPrevio) => {
        soloElPrevio(intento({ status: estadoPrevio }));

        const r = await pagoNuevo();

        expect(r).toEqual(
          expect.objectContaining({
            gatewayPaymentId: 'mp-2',
            status: 'approved',
            isDeposit: false,
          }),
        );
        expect(r?.montoDistinto).toBeUndefined();
        expect(paymentRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            orderId: 'ord-1',
            distributorId: 'dist-1',
            credentialId: null,
            amount: 3000,
            isDeposit: false,
            status: LedgerPaymentStatus.PENDING,
            metadata: { preferenceId: 'pref-1' },
          }),
        );
        expect(paymentRepository.save).toHaveBeenLastCalledWith(
          expect.objectContaining({
            paymentId: 'ledger-2',
            gatewayPaymentId: 'mp-2',
            status: LedgerPaymentStatus.APPROVED,
          }),
        );
        expect(ventasEnCaja.asentarCobroDeMercadoPago).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            paymentId: 'ledger-2',
            gatewayPaymentId: 'mp-2',
            amount: 3000,
          }),
        );
        expect(events.emit).not.toHaveBeenCalled();
      },
    );

    it('con cuenta propia: el intento nuevo hereda la credencial y se confirma', async () => {
      soloElPrevio(intento({ credentialId: 'cred-1' }));

      const r = await pagoNuevo({}, 'cred-1');

      expect(r).not.toBeNull();
      expect(paymentRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ credentialId: 'cred-1' }),
      );
      expect(ventasEnCaja.asentarCobroDeMercadoPago).toHaveBeenCalledTimes(1);
    });

    it('un pago de otra cuenta contra el checkout del pedido no abre ningún intento', async () => {
      soloElPrevio(intento({ credentialId: 'cred-1' }));

      expect(await pagoNuevo({}, 'cred-OTRA')).toBeNull();
      expect(paymentRepository.create).not.toHaveBeenCalled();
      expect(ventasEnCaja.asentarCobroDeMercadoPago).not.toHaveBeenCalled();
    });

    it('el pago nuevo aprobado por otro monto queda marcado y no se da por pagado', async () => {
      soloElPrevio(intento());

      const r = await pagoNuevo({ amount: 2000 });

      expect(r?.montoDistinto).toEqual({ esperado: 3000, cobrado: 2000 });
    });

    it('un pago nuevo rechazado también queda registrado (queda como rechazado)', async () => {
      soloElPrevio(intento());

      const r = await pagoNuevo({ status: 'rejected' });

      expect(r?.status).toBe('rejected');
      expect(paymentRepository.save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          gatewayPaymentId: 'mp-2',
          status: LedgerPaymentStatus.REJECTED,
        }),
      );
    });

    it('sin ningún intento del pedido y con la cuenta del entorno: se confirma como hasta ahora y se avisa al administrador', async () => {
      soloElPrevio(null);

      const r = await pagoNuevo();

      expect(r).toEqual(
        expect.objectContaining({ gatewayPaymentId: 'mp-2', isDeposit: false }),
      );
      expect(paymentRepository.create).not.toHaveBeenCalled();
      expect(events.emit).toHaveBeenCalledWith(
        'admin.notificar',
        expect.objectContaining({
          distributorId: 'dist-1',
          kind: 'payment_without_attempt',
          dedupeKey: 'mp-sin-intento:mp-2',
        }),
      );
    });

    it('sin ningún intento del pedido y con una cuenta propia: no se confirma, pero se avisa', async () => {
      soloElPrevio(null);

      expect(await pagoNuevo({}, 'cred-1')).toBeNull();
      expect(events.emit).toHaveBeenCalledWith(
        'admin.notificar',
        expect.objectContaining({ kind: 'payment_without_attempt' }),
      );
    });

    it('la devolución desde el panel de MP no se informa si hay una solicitud de reintegro propia de ese pago', async () => {
      paymentRepository.count.mockResolvedValue(1);
      paymentRepository.findOne.mockResolvedValueOnce(
        intento({
          status: LedgerPaymentStatus.APPROVED,
          gatewayPaymentId: 'mp-2',
        }),
      );

      const r = await pagoNuevo({ status: 'refunded', refundedAmount: null });

      expect(r?.devolucionExterna).toBeUndefined();
    });
  });

  describe('los nueve estados de Mercado Pago, el motivo y el historial', () => {
    const intento = (estado: LedgerPaymentStatus) => ({
      paymentId: 'ledger-1',
      orderId: 'ord-1',
      distributorId: 'dist-1',
      externalReference: 'ord-1',
      gatewayPaymentId: 'pay-1',
      credentialId: null,
      isDeposit: false,
      amount: 1000,
      status: estado,
      statusDetail: null as string | null,
      statusHistory: [] as Array<Record<string, unknown>>,
      approvedAt: null as Date | null,
      metadata: null as Record<string, unknown> | null,
    });
    const aviso = (status: string, statusDetail?: string, extra = {}) => {
      paymentGateway.getPayment.mockResolvedValue({
        id: 'pay-1',
        status,
        statusDetail,
        externalReference: 'ord-1',
        amount: 1000,
        ...extra,
      });
      return service.confirmFromGateway({ type: 'payment', dataId: 'pay-1' });
    };

    it.each([
      ['pending', LedgerPaymentStatus.PENDING],
      ['in_process', LedgerPaymentStatus.IN_PROCESS],
      ['authorized', LedgerPaymentStatus.AUTHORIZED],
      ['approved', LedgerPaymentStatus.APPROVED],
      ['rejected', LedgerPaymentStatus.REJECTED],
      ['cancelled', LedgerPaymentStatus.CANCELLED],
      ['refunded', LedgerPaymentStatus.REFUNDED],
      ['charged_back', LedgerPaymentStatus.CHARGED_BACK],
      ['in_mediation', LedgerPaymentStatus.IN_MEDIATION],
    ])(
      'un pago nuevo que Mercado Pago informa como %s queda en el ledger como %s',
      async (deMp, esperado) => {
        const pago = intento(LedgerPaymentStatus.PENDING);
        paymentRepository.findOne.mockResolvedValueOnce(pago);

        await aviso(deMp);

        expect(pago.status).toBe(esperado);
      },
    );

    it('pending → in_process → approved: cada paso se aplica, con su motivo, y el historial los guarda en orden', async () => {
      const pago = intento(LedgerPaymentStatus.PENDING);
      for (const [estado, motivo] of [
        ['in_process', 'pending_review_manual'],
        ['approved', 'accredited'],
      ]) {
        paymentRepository.findOne.mockResolvedValueOnce(pago);
        await aviso(estado, motivo);
      }

      expect(pago.status).toBe(LedgerPaymentStatus.APPROVED);
      expect(pago.statusDetail).toBe('accredited');
      expect(
        pago.statusHistory.map((h) => [h.status, h.statusDetail, h.applied]),
      ).toEqual([
        ['in_process', 'pending_review_manual', true],
        ['approved', 'accredited', true],
      ]);
    });

    it('el historial dice de dónde salió cada lectura', async () => {
      const pago = intento(LedgerPaymentStatus.PENDING);
      paymentRepository.findOne.mockResolvedValueOnce(pago);
      paymentGateway.getPayment.mockResolvedValue({
        id: 'pay-1',
        status: 'approved',
        externalReference: 'ord-1',
        amount: 1000,
      });

      await service.confirmFromGateway({
        type: 'payment',
        dataId: 'pay-1',
        origin: OrigenDelEstadoDelPago.CONCILIACION,
      });

      expect(pago.statusHistory[0]).toMatchObject({
        origin: 'conciliacion',
        applied: true,
        at: expect.any(String) as string,
      });
    });

    it('un rechazo guarda el motivo (cc_rejected_*) para mostrarlo', async () => {
      const pago = intento(LedgerPaymentStatus.PENDING);
      paymentRepository.findOne.mockResolvedValueOnce(pago);

      const r = await aviso('rejected', 'cc_rejected_insufficient_amount');

      expect(pago.statusDetail).toBe('cc_rejected_insufficient_amount');
      expect(r?.statusDetail).toBe('cc_rejected_insufficient_amount');
    });

    it('el mismo aviso repetido (reintento de MP) no ensucia el historial', async () => {
      const pago = intento(LedgerPaymentStatus.PENDING);
      for (let i = 0; i < 3; i++) {
        paymentRepository.findOne.mockResolvedValueOnce(pago);
        await aviso('approved', 'accredited');
      }

      expect(pago.statusHistory).toHaveLength(1);
    });

    it('el mismo estado con otro motivo sí queda registrado', async () => {
      const pago = intento(LedgerPaymentStatus.PENDING);
      paymentRepository.findOne.mockResolvedValueOnce(pago);
      await aviso('approved', 'accredited');
      paymentRepository.findOne.mockResolvedValueOnce(pago);
      await aviso('approved', 'partially_refunded');

      expect(pago.statusHistory).toHaveLength(2);
      expect(pago.statusDetail).toBe('partially_refunded');
    });

    describe('orden fuera de secuencia: un estado terminal no retrocede', () => {
      it.each([
        ['refunded', 'approved'],
        ['refunded', 'in_mediation'],
        ['charged_back', 'approved'],
        ['charged_back', 'in_mediation'],
        ['charged_back', 'refunded'],
        ['rejected', 'approved'],
        ['cancelled', 'approved'],
        ['approved', 'in_process'],
        ['approved', 'pending'],
        ['in_process', 'pending'],
      ])('un %s no vuelve a %s', async (actual, atrasado) => {
        const pago = intento(actual as LedgerPaymentStatus);
        paymentRepository.findOne.mockResolvedValueOnce(pago);

        const r = await aviso(atrasado);

        expect(pago.status).toBe(actual);
        expect(r?.status).toBe(actual);
        expect(pago.statusHistory[0]).toMatchObject({
          status: atrasado,
          applied: false,
        });
      });

      it('el aviso atrasado no asienta cobros ni avisos', async () => {
        const pago = intento(LedgerPaymentStatus.REFUNDED);
        paymentRepository.findOne.mockResolvedValueOnce(pago);

        await aviso('approved');

        expect(ventasEnCaja.asentarCobroDeMercadoPago).not.toHaveBeenCalled();
        expect(events.emit).not.toHaveBeenCalled();
      });
    });

    describe('M-1 / M-2: contracargo y su status_detail', () => {
      it('M-1: el contracargo saca el TOTAL del pago, no lo ya devuelto (el reintegro parcial se descuenta al asentar)', async () => {
        const pago = {
          ...intento(LedgerPaymentStatus.APPROVED),
          amount: 10000,
        };
        paymentRepository.findOne.mockResolvedValueOnce(pago);

        await aviso('charged_back', 'settled', {
          amount: 10000,
          refundedAmount: 1500,
        });

        expect(ventasEnCaja.asentarDevolucionExterna).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ refundedTotal: 10000, contracargo: true }),
        );
      });

      it('S-1: charged_back/settled («el dinero quedó retenido tras el proceso») asienta el egreso', async () => {
        paymentRepository.findOne.mockResolvedValueOnce(
          intento(LedgerPaymentStatus.APPROVED),
        );

        await aviso('charged_back', 'settled');

        expect(ventasEnCaja.asentarDevolucionExterna).toHaveBeenCalledTimes(1);
      });

      it.each(['in_process', null])(
        'S-1: charged_back/%s (disputa abierta: el monto queda retenido, no retirado) NO saca plata de la caja',
        async (detalle) => {
          paymentRepository.findOne.mockResolvedValueOnce(
            intento(LedgerPaymentStatus.APPROVED),
          );

          await aviso('charged_back', detalle as string);

          expect(ventasEnCaja.asentarDevolucionExterna).not.toHaveBeenCalled();
        },
      );

      it('S-1: charged_back/reimbursed con el caso resuelto a favor del comercio (coverage_applied) hace el contra-asiento automático', async () => {
        const pago = intento(LedgerPaymentStatus.CHARGED_BACK);
        pago.statusDetail = 'settled';
        pago.metadata = { chargeback: { coverageApplied: true } };
        paymentRepository.findOne.mockResolvedValueOnce(pago);

        const r = await aviso('charged_back', 'reimbursed');

        expect(ventasEnCaja.asentarDevolucionExterna).not.toHaveBeenCalled();
        expect(ventasEnCaja.asentarContracargoReintegrado).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ automatico: true }),
        );
        expect(r?.contracargoReintegrado).toBe(true);
        expect(pago.statusDetail).toBe('reimbursed');
      });

      it('S-1: reimbursed SIN la resolución del caso no asienta solo: queda a conciliar con aviso', async () => {
        const pago = intento(LedgerPaymentStatus.CHARGED_BACK);
        pago.statusDetail = 'settled';
        ventasEnCaja.asentarContracargoReintegrado.mockResolvedValue(
          'a_conciliar',
        );
        paymentRepository.findOne.mockResolvedValueOnce(pago);

        const r = await aviso('charged_back', 'reimbursed');

        expect(ventasEnCaja.asentarContracargoReintegrado).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ automatico: false }),
        );
        expect(r?.contracargoReintegrado).toBeUndefined();
        expect(r?.contracargoAConciliar).toBe(true);
      });

      it('M-3: se decide por el estado de la caja, no por el cambio de detalle: si el asiento falló, el aviso siguiente (mismo detalle) lo reintenta', async () => {
        const pago = intento(LedgerPaymentStatus.CHARGED_BACK);
        pago.statusDetail = 'reimbursed';
        pago.metadata = { chargeback: { coverageApplied: true } };
        paymentRepository.findOne.mockResolvedValueOnce(pago);

        const r = await aviso('charged_back', 'reimbursed');

        expect(
          ventasEnCaja.asentarContracargoReintegrado,
        ).toHaveBeenCalledTimes(1);
        expect(r?.contracargoReintegrado).toBe(true);
      });

      it('B-3: reimbursed que llega sin haber visto el settled (sin egreso en la caja) no avisa nada de contracargo resuelto', async () => {
        const pago = intento(LedgerPaymentStatus.APPROVED);
        ventasEnCaja.asentarContracargoReintegrado.mockResolvedValue(
          'sin_efecto',
        );
        paymentRepository.findOne.mockResolvedValueOnce(pago);

        const r = await aviso('charged_back', 'reimbursed');

        expect(r?.contracargoReintegrado).toBeUndefined();
        expect(r?.contracargoAConciliar).toBeUndefined();
      });

      it('M-6: un status_detail vacío se guarda como null', async () => {
        const pago = intento(LedgerPaymentStatus.PENDING);
        paymentRepository.findOne.mockResolvedValueOnce(pago);

        await aviso('approved', '');

        expect(pago.statusDetail).toBeNull();
        expect(pago.statusHistory[0]).toMatchObject({ statusDetail: null });
      });
    });

    describe('approved ↔ in_mediation → charged_back', () => {
      it.each([
        ['approved', 'in_mediation'],
        ['in_mediation', 'approved'],
        ['in_mediation', 'charged_back'],
        ['in_mediation', 'refunded'],
        ['approved', 'charged_back'],
        ['approved', 'refunded'],
        ['in_process', 'approved'],
        ['in_process', 'rejected'],
        ['authorized', 'approved'],
        ['pending', 'in_process'],
      ])('%s → %s se aplica', async (actual, nuevo) => {
        const pago = intento(actual as LedgerPaymentStatus);
        paymentRepository.findOne.mockResolvedValueOnce(pago);

        await aviso(nuevo);

        expect(pago.status).toBe(nuevo);
        expect(pago.statusHistory[0]).toMatchObject({ applied: true });
      });

      it('un contracargo pone el ledger en charged_back, asienta el egreso y se informa como devolución externa', async () => {
        const pago = intento(LedgerPaymentStatus.APPROVED);
        paymentRepository.findOne.mockResolvedValueOnce(pago);

        const r = await aviso('charged_back', 'settled');

        expect(pago.status).toBe(LedgerPaymentStatus.CHARGED_BACK);
        expect(ventasEnCaja.asentarDevolucionExterna).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ contracargo: true, refundedTotal: 1000 }),
        );
        expect(r?.devolucionExterna).toEqual({ contracargo: true });
      });

      it('si el sistema ya había devuelto ese pago, el contracargo no se avisa dos veces como externo', async () => {
        const pago = intento(LedgerPaymentStatus.REFUNDED);
        paymentRepository.findOne.mockResolvedValueOnce(pago);
        paymentRepository.count.mockResolvedValue(1);

        const r = await aviso('charged_back');

        expect(pago.status).toBe(LedgerPaymentStatus.REFUNDED);
        expect(r?.devolucionExterna).toBeUndefined();
      });
    });

    it('un segundo pago aprobado sobre un checkout cuyo primer pago ya se cobró abre su propio intento (para poder devolverlo)', async () => {
      const cobrado = {
        ...intento(LedgerPaymentStatus.APPROVED),
        gatewayPaymentId: 'pay-1',
        paymentUrl: 'https://mp.test/pref',
        gateway: 'mercadopago',
        integration: 'checkout_pro',
        metadata: { preferenceId: 'pref-1' } as Record<string, unknown>,
      };
      paymentRepository.findOne
        .mockResolvedValueOnce(null) // por id de pasarela
        .mockResolvedValueOnce(null) // intento libre
        .mockResolvedValueOnce(null) // por id, con el libre bloqueado
        .mockResolvedValueOnce(cobrado) // el intento previo, aunque esté aprobado
        .mockResolvedValueOnce(null); // por id, con el previo bloqueado
      paymentRepository.save.mockImplementation((e: Record<string, unknown>) =>
        Promise.resolve({ paymentId: 'ledger-2', ...e }),
      );
      paymentGateway.getPayment.mockResolvedValue({
        id: 'pay-2',
        status: 'approved',
        externalReference: 'ord-1',
        amount: 1000,
      });

      const r = await service.confirmFromGateway({
        type: 'payment',
        dataId: 'pay-2',
      });

      expect(r?.gatewayPaymentId).toBe('pay-2');
      // El intento previo se busca sin filtrar por estado: uno ya cobrado también cuenta.
      const busquedaDelPrevio = (
        paymentRepository.findOne.mock.calls[3] as [
          { where: Record<string, unknown> },
        ]
      )[0];
      expect(busquedaDelPrevio.where).not.toHaveProperty('status');
      expect(paymentRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: 'ord-1',
          status: LedgerPaymentStatus.PENDING,
        }),
      );
      expect(paymentRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          gatewayPaymentId: 'pay-2',
          status: LedgerPaymentStatus.APPROVED,
        }),
      );
    });
  });

  describe('alerta de fraude (stop_delivery_op_wh)', () => {
    const fila = (credentialId: string | null) => ({
      paymentId: 'ledger-1',
      orderId: 'ord-1',
      distributorId: 'dist-1',
      externalReference: 'ord-1',
      gatewayPaymentId: 'pay-1',
      credentialId,
      isDeposit: false,
      amount: 1000,
      status: LedgerPaymentStatus.APPROVED,
      statusDetail: 'accredited',
      statusHistory: [] as unknown[],
      metadata: null as Record<string, unknown> | null,
    });
    /** `findOne` que respeta el filtro de cuenta (`credentialId`) como lo haría la base. */
    const ledgerCon = (row: ReturnType<typeof fila>) =>
      paymentRepository.findOne.mockImplementation(
        (op: { where: { credentialId?: unknown } }) => {
          const c = op.where.credentialId;
          if (c === undefined) return Promise.resolve(row);
          const pedida = c instanceof FindOperator ? null : c;
          return Promise.resolve(
            (row.credentialId ?? null) === pedida ? row : null,
          );
        },
      );
    const pagoDeMp = {
      id: 'pay-1',
      status: 'approved',
      statusDetail: 'accredited',
      externalReference: 'ord-1',
      amount: 1000,
    };

    beforeEach(() => paymentGateway.getPayment.mockResolvedValue(pagoDeMp));

    it('marca el pago y devuelve la alerta para que el pedido no se entregue', async () => {
      const p = fila(null);
      ledgerCon(p);

      const r = await service.confirmFromGateway({
        type: 'stop_delivery_op_wh',
        dataId: 'pay-1',
      });

      expect(r).toMatchObject({
        externalReference: 'ord-1',
        gatewayPaymentId: 'pay-1',
        alertaDeFraude: true,
      });
      expect(p.metadata).toMatchObject({
        fraudAlert: { notifiedAt: expect.any(String) as string },
      });
    });

    it('A-1: el pago SIEMPRE se lee de Mercado Pago con la cuenta que firmó el aviso', async () => {
      ledgerCon(fila('cred-A'));

      await service.confirmFromGateway({
        type: 'stop_delivery_op_wh',
        dataId: 'pay-1',
        credentialId: 'cred-A',
      });

      expect(paymentGateway.getPayment).toHaveBeenCalledWith('pay-1', 'cred-A');
    });

    it('A-1: una cuenta que firma con SU secreto un pago de OTRA distribuidora no retiene nada (MP no lo tiene en esa cuenta: 404)', async () => {
      const ajeno = fila('cred-A');
      ledgerCon(ajeno);
      paymentGateway.getPayment.mockRejectedValue({ status: 404 });

      const r = await service.confirmFromGateway({
        type: 'stop_delivery_op_wh',
        dataId: 'pay-1',
        credentialId: 'cred-B',
      });

      expect(r).toBeNull();
      expect(ajeno.metadata).toBeNull();
    });

    it('A-1: aunque Mercado Pago devolviera el pago, si el ledger lo tiene con otra cuenta se descarta sin marcar', async () => {
      const ajeno = fila('cred-A');
      ledgerCon(ajeno);

      const r = await service.confirmFromGateway({
        type: 'stop_delivery_op_wh',
        dataId: 'pay-1',
        credentialId: 'cred-B',
      });

      expect(r).toBeNull();
      expect(ajeno.metadata).toBeNull();
    });

    it('A-1: una cuenta propia no puede marcar un pago cobrado con la cuenta del sistema (ni al revés)', async () => {
      const delSistema = fila(null);
      ledgerCon(delSistema);

      await expect(
        service.confirmFromGateway({
          type: 'stop_delivery_op_wh',
          dataId: 'pay-1',
          credentialId: 'cred-B',
        }),
      ).resolves.toBeNull();
      expect(delSistema.metadata).toBeNull();
    });

    it('un pago sin external_reference se descarta', async () => {
      ledgerCon(fila(null));
      paymentGateway.getPayment.mockResolvedValue({
        ...pagoDeMp,
        externalReference: null,
      });

      await expect(
        service.confirmFromGateway({
          type: 'stop_delivery_op_wh',
          dataId: 'pay-1',
        }),
      ).resolves.toBeNull();
    });

    it('repetida no cambia la fecha de la primera alerta', async () => {
      const p = fila(null);
      ledgerCon(p);
      await service.confirmFromGateway({
        type: 'stop_delivery_op_wh',
        dataId: 'pay-1',
      });
      const primera = (p.metadata?.fraudAlert as { notifiedAt: string })
        .notifiedAt;

      await service.confirmFromGateway({
        type: 'stop_delivery_op_wh',
        dataId: 'pay-1',
      });

      expect(
        (p.metadata?.fraudAlert as { notifiedAt: string }).notifiedAt,
      ).toBe(primera);
    });

    it('si Mercado Pago no responde lanza: la bandeja de entrada lo reintenta', async () => {
      ledgerCon(fila(null));
      paymentGateway.getPayment.mockRejectedValue(new Error('timeout'));

      await expect(
        service.confirmFromGateway({
          type: 'stop_delivery_op_wh',
          dataId: 'pay-1',
        }),
      ).rejects.toThrow('timeout');
    });
  });

  describe('estado del pago de un pedido (API v2)', () => {
    const ahora = Date.now();
    const intento = (
      estado: LedgerPaymentStatus,
      over: Record<string, unknown> = {},
    ) =>
      ({
        orderId: 'ord-1',
        status: estado,
        statusDetail: null,
        statusHistory: [],
        paymentUrl: 'https://mp.test/pref',
        gatewayPaymentId: 'pay-1',
        isDeposit: false,
        createdAt: new Date(ahora - 60_000),
        metadata: { expiresAt: new Date(ahora + 3_600_000).toISOString() },
        ...over,
      }) as unknown as Payment;

    it('sin pagos de Mercado Pago: estado nulo y sin reintento', async () => {
      paymentRepository.find.mockResolvedValue([]);

      await expect(
        service.estadoDelPagoDelPedido('ord-1', false),
      ).resolves.toMatchObject({
        paymentStatus: null,
        paymentStatusLabel: null,
        canRetry: false,
        paymentUrl: null,
      });
    });

    it('pedido cancelado con el pago sin completar: no dice «Esperando el pago»', async () => {
      paymentRepository.find.mockResolvedValue([
        intento(LedgerPaymentStatus.PENDING),
      ]);
      orderLookup.findPaymentState.mockResolvedValue({
        status: OrderStatus.CANCELLED,
        paymentStatus: PaymentStatus.PENDING,
        createdAt: new Date(),
        distributorId: 'dist-1',
      });

      await expect(
        service.estadoDelPagoDelPedido('ord-1', false),
      ).resolves.toMatchObject({
        paymentStatus: 'pending',
        paymentStatusLabel: 'Sin pagar: el pedido se canceló',
        canRetry: false,
        paymentUrl: null,
      });
    });

    it('rechazado: el motivo y el texto en castellano vienen del back, y se puede reintentar si el pedido sigue vivo', async () => {
      paymentRepository.find.mockResolvedValue([
        intento(LedgerPaymentStatus.REJECTED, {
          statusDetail: 'cc_rejected_insufficient_amount',
        }),
      ]);

      const r = await service.estadoDelPagoDelPedido('ord-1', false);

      expect(r).toMatchObject({
        paymentStatus: 'rejected',
        paymentStatusDetail: 'cc_rejected_insufficient_amount',
        paymentStatusLabel: 'Fondos insuficientes en el medio de pago',
        canRetry: true,
        paymentUrl: 'https://mp.test/pref',
      });
    });

    it('M-1: un pedido retenido por fraude lo dice y no permite reintentar', async () => {
      orderLookup.findPaymentState.mockResolvedValue({
        status: OrderStatus.PENDING,
        paymentStatus: PaymentStatus.PENDING,
        createdAt: new Date(),
        distributorId: 'dist-1',
        paymentFraudHold: true,
      });
      paymentRepository.find.mockResolvedValue([
        intento(LedgerPaymentStatus.REJECTED),
      ]);

      const r = await service.estadoDelPagoDelPedido('ord-1', false);

      expect(r.paymentFraudHold).toBe(true);
      expect(r.canRetry).toBe(false);
    });

    it('sin retención el pedido lo informa en falso', async () => {
      paymentRepository.find.mockResolvedValue([]);
      expect(
        (await service.estadoDelPagoDelPedido('ord-1', false)).paymentFraudHold,
      ).toBe(false);
    });

    it('rechazado sin motivo conocido: «Rechazado por el banco»', async () => {
      paymentRepository.find.mockResolvedValue([
        intento(LedgerPaymentStatus.REJECTED, {
          statusDetail: 'algo_nuevo_de_mp',
        }),
      ]);

      const r = await service.estadoDelPagoDelPedido('ord-1', false);

      expect(r.paymentStatusLabel).toBe('Rechazado por el banco');
    });

    it.each([
      ['pedido cancelado', { status: OrderStatus.CANCELLED }],
      ['pedido entregado', { status: OrderStatus.DELIVERED }],
      ['pedido ya pagado', { paymentStatus: PaymentStatus.PAID }],
    ])('%s: no se puede reintentar', async (_n, estado) => {
      orderLookup.findPaymentState.mockResolvedValue({
        status: OrderStatus.PENDING,
        paymentStatus: PaymentStatus.PENDING,
        createdAt: new Date(),
        distributorId: 'dist-1',
        ...estado,
      });
      paymentRepository.find.mockResolvedValue([
        intento(LedgerPaymentStatus.REJECTED),
      ]);

      const r = await service.estadoDelPagoDelPedido('ord-1', false);

      expect(r.canRetry).toBe(false);
      expect(r.paymentUrl).toBeNull();
    });

    it('el checkout vencido no se puede reintentar', async () => {
      paymentRepository.find.mockResolvedValue([
        intento(LedgerPaymentStatus.REJECTED, {
          metadata: { expiresAt: new Date(ahora - 1000).toISOString() },
        }),
      ]);

      expect(
        (await service.estadoDelPagoDelPedido('ord-1', false)).canRetry,
      ).toBe(false);
    });

    it('en curso (in_process) no se reintenta, y el texto lo dice', async () => {
      paymentRepository.find.mockResolvedValue([
        intento(LedgerPaymentStatus.IN_PROCESS, {
          statusDetail: 'pending_review_manual',
        }),
      ]);

      const r = await service.estadoDelPagoDelPedido('ord-1', false);

      expect(r.canRetry).toBe(false);
      expect(r.paymentStatusLabel).toContain('Pago en revisión');
    });

    it('si hay varios intentos, el cobrado representa al pedido aunque haya uno posterior devuelto', async () => {
      paymentRepository.find.mockResolvedValue([
        intento(LedgerPaymentStatus.APPROVED, { gatewayPaymentId: 'pay-1' }),
        intento(LedgerPaymentStatus.REFUNDED, { gatewayPaymentId: 'pay-2' }),
      ]);

      expect(
        (await service.estadoDelPagoDelPedido('ord-1', false)).paymentStatus,
      ).toBe('approved');
    });

    it('un rechazo anterior no tapa al intento nuevo en curso', async () => {
      paymentRepository.find.mockResolvedValue([
        intento(LedgerPaymentStatus.REJECTED, { gatewayPaymentId: 'pay-1' }),
        intento(LedgerPaymentStatus.IN_PROCESS, { gatewayPaymentId: 'pay-2' }),
      ]);

      expect(
        (await service.estadoDelPagoDelPedido('ord-1', false)).paymentStatus,
      ).toBe('in_process');
    });

    it('el historial sólo se incluye si se pide, con el texto de cada paso', async () => {
      paymentRepository.find.mockResolvedValue([
        intento(LedgerPaymentStatus.REJECTED, {
          statusHistory: [
            {
              status: 'rejected',
              statusDetail: 'cc_rejected_bad_filled_date',
              at: '2026-11-01T10:00:00.000Z',
              origin: 'webhook',
              applied: true,
            },
          ],
        }),
      ]);

      const sin = await service.estadoDelPagoDelPedido('ord-1', false);
      const con = await service.estadoDelPagoDelPedido('ord-1', true);

      expect(sin).not.toHaveProperty('history');
      expect(con.history?.[0]).toMatchObject({
        label: 'Revisá la fecha de vencimiento de la tarjeta',
        gatewayPaymentId: 'pay-1',
      });
    });

    it('estadosDelPagoDePedidos arma uno por pedido', async () => {
      paymentRepository.find.mockResolvedValue([
        intento(LedgerPaymentStatus.APPROVED, { orderId: 'o1' }),
      ]);

      const r = await service.estadosDelPagoDePedidos(['o1', 'o2']);

      expect(r.map((e) => [e.orderId, e.paymentStatus])).toEqual([
        ['o1', 'approved'],
        ['o2', null],
      ]);
    });
  });

  describe('cerrarCheckoutsDelPedido', () => {
    const abierto = (
      preferenceId: string | null,
      credentialId: string | null,
    ) =>
      ({
        orderId: 'ord-1',
        credentialId,
        metadata: preferenceId ? { preferenceId } : null,
      }) as unknown as Payment;

    beforeEach(() => {
      (paymentGateway as Record<string, jest.Mock>).expireCheckout = jest
        .fn()
        .mockResolvedValue(undefined);
    });

    const expirar = () =>
      (paymentGateway as unknown as { expireCheckout: jest.Mock })
        .expireCheckout;

    it('vence cada preferencia abierta del pedido, una sola vez, con la cuenta que la creó', async () => {
      paymentRepository.find.mockResolvedValue([
        abierto('pref-1', 'cred-1'),
        abierto('pref-1', 'cred-1'),
        abierto('pref-2', null),
        abierto(null, null),
      ]);

      await service.cerrarCheckoutsDelPedido('ord-1');

      expect(expirar()).toHaveBeenCalledTimes(2);
      expect(expirar()).toHaveBeenCalledWith('pref-1', 'cred-1');
      expect(expirar()).toHaveBeenCalledWith('pref-2', null);
    });

    it('cierra también el checkout de un pedido que ya se había cobrado (el enlace sigue abierto)', async () => {
      paymentRepository.find.mockResolvedValue([]);

      await service.cerrarCheckoutsDelPedido('ord-1');

      expect(paymentRepository.find).toHaveBeenCalledWith({
        where: { orderId: 'ord-1', gateway: 'mercadopago' },
      });
    });

    it('si la pasarela falla no lanza: sigue con las demás preferencias', async () => {
      paymentRepository.find.mockResolvedValue([
        abierto('pref-1', null),
        abierto('pref-2', null),
      ]);
      expirar().mockRejectedValueOnce(new Error('MP caído'));

      await expect(
        service.cerrarCheckoutsDelPedido('ord-1'),
      ).resolves.toBeUndefined();
      expect(expirar()).toHaveBeenCalledTimes(2);
    });

    it('si no se pueden leer los intentos tampoco lanza', async () => {
      paymentRepository.find.mockRejectedValue(new Error('base'));

      await expect(
        service.cerrarCheckoutsDelPedido('ord-1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('verifyWebhookSignature', () => {
    it('delega en el port, sin lógica propia', () => {
      paymentGateway.verifyWebhookSignature.mockReturnValue('valida');

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
      expect(result).toBe('valida');
    });
  });
});
