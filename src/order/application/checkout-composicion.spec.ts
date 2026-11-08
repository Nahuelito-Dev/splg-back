import { ConfigService } from '@nestjs/config';
import type { SalesCashService } from '../../cash/application/sales-cash.service';
import Decimal from 'decimal.js';
import { DataSource, Repository } from 'typeorm';
import { CreateOrderUseCase } from './create-order.use-case';
import { ConfirmPaymentUseCase } from './confirm-payment.use-case';
import { CreateOrderDto } from '../dto/create-order.dto';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../entities/order.entity';
import { OrderPricingService } from '../domain/order-pricing.service';
import { CoverageZonePricingService } from '../../coverage-zone/coverage-zone-pricing.service';
import { CoverageZoneSurchargeType } from '../../coverage-zone/entities/coverage-zone.entity';
import { PaymentsService } from '../../payments/application/payments.service';
import { Payment } from '../../payments/entities/payment.entity';
import {
  PaymentCheckoutItem,
  PaymentGatewayPort,
} from '../../payments/domain/ports/payment-gateway.port';
import { OrderLookupService } from '../lookup/order-lookup.service';
import { RefundsService } from '../../payments/application/refunds.service';

/**
 * Composición del cobro de MercadoPago: lo que se le pide a la pasarela
 * (renglones del checkout) tiene que sumar EXACTAMENTE lo que queda en el
 * ledger, y un pago legítimo aprobado por ese importe tiene que llegar al
 * despacho. Se usan el pricing real, el `PaymentsService` real con un ledger en
 * memoria y el `ConfirmPaymentUseCase` real; sólo la pasarela y la base son falsas.
 */
describe('Checkout de MercadoPago: composición y punta a punta', () => {
  const ZONA_FIJA = {
    id: 'z1',
    name: 'Posadas',
    type: CoverageZoneSurchargeType.FIXED,
    value: 500,
    color: null,
  };
  const ZONA_PORCENTUAL = {
    id: 'z2',
    name: 'Villa Lanús',
    type: CoverageZoneSurchargeType.PERCENTAGE,
    value: 7.5,
    color: null,
  };

  let ledger: Payment[];
  let checkoutsEnviados: PaymentCheckoutItem[][];
  let guardados: Record<string, Order>;
  let zona: typeof ZONA_FIJA | null;
  let precioDeLista: number;
  let offerToNextDriver: jest.Mock;
  let crear: CreateOrderUseCase;
  let confirmar: ConfirmPaymentUseCase;

  const sumaDeRenglones = (items: PaymentCheckoutItem[]): Decimal =>
    items.reduce(
      (acc, i) => acc.plus(new Decimal(i.unitPrice).times(i.quantity)),
      new Decimal(0),
    );

  beforeEach(() => {
    ledger = [];
    checkoutsEnviados = [];
    guardados = {};
    zona = null;
    precioDeLista = 1000;
    offerToNextDriver = jest.fn().mockResolvedValue('drv-1');

    const repoDeLedger = {
      create: (data: Partial<Payment>) => ({ ...data }) as Payment,
      save: (p: Payment) => {
        if (!ledger.includes(p)) ledger.push(p);
        return Promise.resolve(p);
      },
      findOne: ({
        where,
      }: {
        where: { gatewayPaymentId: unknown; externalReference?: string };
      }) =>
        Promise.resolve(
          typeof where.gatewayPaymentId === 'string'
            ? (ledger.find(
                (p) => p.gatewayPaymentId === where.gatewayPaymentId,
              ) ?? null)
            : (ledger.find(
                (p) =>
                  p.externalReference === where.externalReference &&
                  !p.gatewayPaymentId,
              ) ?? null),
        ),
      find: () => Promise.resolve(ledger),
      manager: {
        transaction: (trabajo: (m: unknown) => unknown) =>
          trabajo({ getRepository: () => repoDeLedger }),
      },
    };
    const pasarela = {
      createCheckout: jest.fn((input: { items: PaymentCheckoutItem[] }) => {
        checkoutsEnviados.push(input.items);
        return Promise.resolve({
          initPoint: 'https://mp.test/checkout',
          preferenceId: 'pref-1',
        });
      }),
      // La pasarela cobra lo que sumaban los renglones del último checkout.
      getPayment: jest.fn(() =>
        Promise.resolve({
          id: 'pay-1',
          status: 'approved',
          externalReference: 'ord-1',
          amount: sumaDeRenglones(
            checkoutsEnviados[checkoutsEnviados.length - 1],
          ).toNumber(),
        }),
      ),
    };
    const payments = new PaymentsService(
      repoDeLedger as unknown as Repository<Payment>,
      pasarela as unknown as PaymentGatewayPort,
      {
        findPaymentState: jest.fn().mockResolvedValue({
          status: OrderStatus.PENDING,
          paymentStatus: PaymentStatus.PENDING,
          createdAt: new Date(),
        }),
      } as unknown as OrderLookupService,
      {
        asentarCobroDeMercadoPago: jest.fn().mockResolvedValue('sin_caja'),
        avisarSinAsentar: jest.fn(),
      } as unknown as SalesCashService,
      {
        getOrThrow: (clave: string) =>
          clave === 'RESERVATION_DEPOSIT_TTL_HOURS' ? 48 : 60,
      } as unknown as ConfigService,
      { emit: jest.fn() } as never,
    );

    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      isTransactionActive: true,
      manager: {
        query: jest.fn().mockResolvedValue([{ deleted: false }]),
        save: jest.fn((o: Order) => {
          const guardado = { ...o, orderId: 'ord-1' } as Order;
          guardados['ord-1'] = guardado;
          return Promise.resolve(guardado);
        }),
        createQueryBuilder: jest.fn(() => ({
          setLock: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getOne: jest.fn(() => Promise.resolve(guardados['ord-1'])),
        })),
      },
    };
    const dataSource = { createQueryRunner: () => queryRunner };
    const orders = {
      findByIdFull: jest.fn(() => Promise.resolve(guardados['ord-1'])),
    };
    const orchestrator = { offerToNextDriver };

    crear = new CreateOrderUseCase(
      dataSource as unknown as DataSource,
      {
        buscarComprador: jest.fn().mockResolvedValue({ email: 'c@test.com' }),
        reactivarVinculo: jest.fn().mockResolvedValue(undefined),
      } as never,
      {
        buscarDelUsuario: jest.fn().mockResolvedValue({
          addressId: 'addr-1',
          location: { type: 'Point', coordinates: [-58.4, -34.6] },
        }),
      } as never,
      { create: (d: unknown) => d } as never,
      { create: (d: unknown) => d } as never,
      new OrderPricingService(),
      {
        reservarStock: jest.fn(() =>
          Promise.resolve({
            gasCylinderId: 'gc-1',
            type: 'Garrafa 10kg',
            price: precioDeLista,
            promotions: [{ quantity: 2, discountPercentage: 3.33 }],
            distributorId: 'dist-1',
          }),
        ),
      } as never,
      orchestrator as never,
      {
        sendOrderConfirmation: jest.fn().mockResolvedValue(undefined),
      } as never,
      orders as never,
      { notifyAdmins: jest.fn() } as never,
      payments,
      { getDefault: jest.fn() } as never,
      {} as never,
      {
        checkCoverage: jest.fn(() =>
          Promise.resolve({ covered: true, surcharge: 0, zone: zona }),
        ),
      } as never,
      new CoverageZonePricingService(),
      {} as never,
      {
        evaluar: jest.fn().mockResolvedValue({
          available: true,
          reason: null,
          message: null,
          settings: { surchargeAmount: 1500 },
        }),
      } as never,
      { assertCredito: jest.fn() } as never,
      { porcentaje: jest.fn().mockResolvedValue(10) } as never,
      { envasesACobrar: jest.fn().mockResolvedValue([]) } as never,
    );

    confirmar = new ConfirmPaymentUseCase(
      dataSource as unknown as DataSource,
      orders as never,
      payments,
      orchestrator as never,
      { notifyCustomer: jest.fn() } as never,
      {
        sendPaymentApprovedPush: jest.fn().mockResolvedValue(undefined),
      } as never,
      { reintegrarPorCancelacion: jest.fn() } as unknown as RefundsService,
      { emit: jest.fn() } as never,
      { withdrawOtherActiveOffers: jest.fn() } as never,
    );
  });

  const dto = (extra: Partial<CreateOrderDto> = {}): CreateOrderDto => ({
    customerId: 'cust-1',
    addressId: 'addr-1',
    items: [{ gasCylinderId: 'gc-1', quantity: 3, unitPrice: 0 }],
    paymentMethod: PaymentMethod.MERCADOPAGO,
    ...extra,
  });

  const casos: Array<
    [string, () => Partial<CreateOrderDto>, typeof ZONA_FIJA | null]
  > = [
    ['pedido normal', () => ({}), null],
    ['pedido con zona fija', () => ({}), ZONA_FIJA],
    ['pedido con zona porcentual (centavos)', () => ({}), ZONA_PORCENTUAL],
    ['pedido express', () => ({ deliveryMode: 'express' as never }), null],
    [
      'pedido express con zona porcentual',
      () => ({ deliveryMode: 'express' as never }),
      ZONA_PORCENTUAL,
    ],
  ];

  describe.each(casos)('%s', (_nombre, extra, laZona) => {
    beforeEach(() => {
      zona = laZona;
      precioDeLista = 1234.56;
    });

    it('los renglones del checkout suman exactamente el monto del ledger y el total del pedido', async () => {
      const { order } = await crear.execute(dto(extra()), 'dist-1');

      expect(ledger).toHaveLength(1);
      expect(ledger[0].isDeposit).toBe(false);
      expect(
        sumaDeRenglones(checkoutsEnviados[0]).equals(
          new Decimal(ledger[0].amount),
        ),
      ).toBe(true);
      expect(Number(ledger[0].amount)).toBe(Number(order.totalAmount));
    });

    it('checkout, webhook aprobado y despacho: el pago legítimo no queda trabado', async () => {
      await crear.execute(dto(extra()), 'dist-1');
      expect(offerToNextDriver).not.toHaveBeenCalled();

      await confirmar.execute({ type: 'payment', dataId: 'pay-1' });

      expect(ledger[0].metadata?.montoDistinto).toBeUndefined();
      expect(guardados['ord-1'].paymentStatus).toBe(PaymentStatus.PAID);
      expect(offerToNextDriver).toHaveBeenCalledTimes(1);
    });
  });

  it('el pedido con zona y recargo online lleva un renglón de cada recargo', async () => {
    zona = ZONA_FIJA;
    await crear.execute(dto(), 'dist-1');

    const ids = checkoutsEnviados[0].map((i) => i.id);
    expect(ids).toEqual(['gc-1', 'zone-surcharge', 'online-surcharge']);
    expect(checkoutsEnviados[0][1].title).toBe('Recargo de zona');
    expect(checkoutsEnviados[0][2].title).toBe('Recargo por pago online');
  });

  describe('reserva con seña', () => {
    it('el checkout cobra exactamente la seña, que es lo que queda en el ledger', async () => {
      zona = ZONA_PORCENTUAL;
      await crear.execute(
        dto({
          isReservation: true,
          scheduledDate: '2099-01-01',
          depositAmount: 1234.57,
        }),
        'dist-1',
      );

      expect(ledger[0].isDeposit).toBe(true);
      expect(Number(ledger[0].amount)).toBe(1234.57);
      expect(sumaDeRenglones(checkoutsEnviados[0]).toNumber()).toBe(1234.57);
    });

    it('la seña aprobada marca deposit_paid y no despacha', async () => {
      await crear.execute(
        dto({
          isReservation: true,
          scheduledDate: '2099-01-01',
          depositAmount: 500,
        }),
        'dist-1',
      );
      await confirmar.execute({ type: 'payment', dataId: 'pay-1' });

      expect(guardados['ord-1'].depositPaid).toBe(true);
      expect(offerToNextDriver).not.toHaveBeenCalled();
    });
  });
});
