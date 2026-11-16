import {
  OrderDeliveryMode,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../entities/order.entity';
import {
  inicioDeLaAgenda,
  inicioDeLaEspera,
  marcarOfrecible,
  PedidoQueEsperaChofer,
  vencimientoSinChofer,
  vencioSinChofer,
} from './vencimiento-sin-chofer';

const MIN = 60_000;
const N = 120;

/** 13/11/2026 10:00 en Argentina (13:00 UTC). */
const T0 = new Date('2026-11-13T13:00:00.000Z');
const mas = (base: Date, minutos: number) =>
  new Date(base.getTime() + minutos * MIN);

const pedido = (
  over: Partial<PedidoQueEsperaChofer> = {},
): PedidoQueEsperaChofer => ({
  status: OrderStatus.PENDING,
  deliveryId: null,
  deliveryMode: OrderDeliveryMode.STANDARD,
  paymentMethod: PaymentMethod.CASH,
  paymentStatus: PaymentStatus.PENDING,
  depositPaid: false,
  paymentFraudHold: false,
  createdAt: T0,
  availableSince: T0,
  scheduledDate: null,
  inicioDeFranja: null,
  ...over,
});

describe('vencimiento de un pedido sin chofer', () => {
  describe('pedido inmediato', () => {
    it('un instante antes de los N minutos no vence; a los N minutos, sí', () => {
      const p = pedido();
      expect(vencioSinChofer(p, N, new Date(mas(T0, N).getTime() - 1))).toBe(
        false,
      );
      expect(vencioSinChofer(p, N, mas(T0, N))).toBe(true);
      expect(vencioSinChofer(p, N, mas(T0, N + 1))).toBe(true);
    });

    it('sin available_since cuenta desde el alta', () => {
      const p = pedido({ availableSince: null, createdAt: mas(T0, -200) });
      expect(inicioDeLaEspera(p)).toEqual(mas(T0, -200));
      expect(vencioSinChofer(p, N, T0)).toBe(true);
    });
  });

  it('Mercado Pago aprobado tarde: cuenta desde la aprobación, no desde el alta', () => {
    const aprobado = mas(T0, 100);
    const p = pedido({
      paymentMethod: PaymentMethod.MERCADOPAGO,
      paymentStatus: PaymentStatus.PAID,
      createdAt: T0,
      availableSince: aprobado,
    });
    expect(vencioSinChofer(p, N, mas(T0, N + 10))).toBe(false);
    expect(vencioSinChofer(p, N, mas(aprobado, N))).toBe(true);
  });

  it('esperando el pago de Mercado Pago nunca vence', () => {
    const p = pedido({
      paymentMethod: PaymentMethod.MERCADOPAGO,
      paymentStatus: PaymentStatus.PENDING,
      availableSince: mas(T0, -10_000),
    });
    expect(vencimientoSinChofer(p, N)).toBeNull();
    expect(vencioSinChofer(p, N, mas(T0, 10_000))).toBe(false);
  });

  it('la reserva con la seña paga por Mercado Pago sí corre (el saldo se cobra al entregar)', () => {
    const p = pedido({
      paymentMethod: PaymentMethod.MERCADOPAGO,
      depositPaid: true,
    });
    expect(vencioSinChofer(p, N, mas(T0, N))).toBe(true);
  });

  it('liberado por el chofer: cuenta desde la liberación', () => {
    const liberado = mas(T0, 90);
    const p = pedido({ createdAt: T0, availableSince: liberado });
    expect(vencioSinChofer(p, N, mas(T0, N))).toBe(false);
    expect(vencioSinChofer(p, N, mas(liberado, N))).toBe(true);
  });

  it('retenido por fraude no vence; liberada la retención, cuenta desde la liberación', () => {
    const retenido = pedido({
      paymentMethod: PaymentMethod.MERCADOPAGO,
      paymentStatus: PaymentStatus.PAID,
      paymentFraudHold: true,
    });
    expect(vencioSinChofer(retenido, N, mas(T0, 10_000))).toBe(false);

    const liberacion = mas(T0, 500);
    const liberado = { ...retenido, paymentFraudHold: false };
    marcarOfrecible(liberado, liberacion);
    expect(vencioSinChofer(liberado, N, mas(liberacion, N - 1))).toBe(false);
    expect(vencioSinChofer(liberado, N, mas(liberacion, N))).toBe(true);
  });

  it.each([
    ['aceptado', { status: OrderStatus.ACCEPTED }],
    ['con chofer', { deliveryId: 'chofer-1' }],
    ['cancelado', { status: OrderStatus.CANCELLED }],
    ['reserva sin activar', { status: OrderStatus.RESERVED }],
    [
      'express (pasa al reparto común, no se cancela)',
      {
        deliveryMode: OrderDeliveryMode.EXPRESS,
      },
    ],
  ] as Array<[string, Partial<PedidoQueEsperaChofer>]>)(
    'nunca vence: %s',
    (_caso, over) => {
      expect(vencioSinChofer(pedido(over), N, mas(T0, 100_000))).toBe(false);
    },
  );

  describe('agendado', () => {
    it('para más adelante, con available_since viejo, no vence antes de su franja + N', () => {
      // Pedido el 10/11 para el 20/11 de 14:00 a 16:00 (17:00 UTC).
      const p = pedido({
        createdAt: new Date('2026-11-10T12:00:00Z'),
        availableSince: new Date('2026-11-10T12:00:00Z'),
        scheduledDate: '2026-11-20',
        inicioDeFranja: '14:00:00',
      });
      const franja = new Date('2026-11-20T17:00:00Z');
      expect(inicioDeLaEspera(p)).toEqual(franja);
      expect(vencioSinChofer(p, N, T0)).toBe(false);
      expect(vencioSinChofer(p, N, mas(franja, N - 1))).toBe(false);
      expect(vencioSinChofer(p, N, mas(franja, N))).toBe(true);
    });

    it('cuya franja ya pasó hace más de N minutos, vence', () => {
      const p = pedido({
        createdAt: new Date('2026-11-12T12:00:00Z'),
        availableSince: new Date('2026-11-12T12:00:00Z'),
        scheduledDate: '2026-11-13',
        inicioDeFranja: '07:30',
      });
      // 07:30 AR = 10:30 UTC; T0 = 13:00 UTC = 150 min después.
      expect(inicioDeLaAgenda(p)).toEqual(new Date('2026-11-13T10:30:00Z'));
      expect(vencioSinChofer(p, N, T0)).toBe(true);
    });

    it('si se liberó después de su franja, cuenta desde la liberación', () => {
      const liberado = mas(T0, -30);
      const p = pedido({
        availableSince: liberado,
        scheduledDate: '2026-11-13',
        inicioDeFranja: '07:30',
      });
      expect(inicioDeLaEspera(p)).toEqual(liberado);
      expect(vencioSinChofer(p, N, T0)).toBe(false);
    });

    it('sin franja: arranca a las 00:00 de su día en Argentina', () => {
      const p = pedido({
        createdAt: new Date('2026-11-01T12:00:00Z'),
        availableSince: new Date('2026-11-01T12:00:00Z'),
        scheduledDate: '2026-11-14',
      });
      const medianoche = new Date('2026-11-14T03:00:00Z');
      expect(inicioDeLaEspera(p)).toEqual(medianoche);
      expect(vencioSinChofer(p, N, mas(medianoche, N - 1))).toBe(false);
      expect(vencioSinChofer(p, N, mas(medianoche, N))).toBe(true);
    });
  });

  it('cada distribuidora con su N: el mismo pedido vence con 30 y no con 120', () => {
    const p = pedido();
    const ahora = mas(T0, 45);
    expect(vencioSinChofer(p, 30, ahora)).toBe(true);
    expect(vencioSinChofer(p, 120, ahora)).toBe(false);
  });

  it('marcarOfrecible deja available_since en el instante dado', () => {
    const p = { availableSince: null as Date | null };
    marcarOfrecible(p, T0);
    expect(p.availableSince).toEqual(T0);
  });
});
