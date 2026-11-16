import { PaymentMethod, PaymentStatus } from '../entities/order.entity';
import {
  esperaPagoOnline,
  mensajeDeEspera,
  MENSAJE_MP_SIN_PAGAR,
  MENSAJE_RETENIDO_POR_FRAUDE,
} from './espera-pago-online';

describe('esperaPagoOnline', () => {
  it.each([
    [PaymentMethod.MERCADOPAGO, PaymentStatus.PENDING, false, true],
    [PaymentMethod.MERCADOPAGO, PaymentStatus.FAILED, false, true],
    [PaymentMethod.MERCADOPAGO, PaymentStatus.PAID, false, false],
    // Reserva con la seña paga: el saldo se cobra al entregar.
    [PaymentMethod.MERCADOPAGO, PaymentStatus.PENDING, true, false],
    [PaymentMethod.CASH, PaymentStatus.PENDING, false, false],
    [PaymentMethod.TRANSFER, PaymentStatus.PENDING, false, false],
  ])(
    '%s con pago %s y seña paga %s → %s',
    (paymentMethod, paymentStatus, depositPaid, espera) => {
      expect(
        esperaPagoOnline({ paymentMethod, paymentStatus, depositPaid }),
      ).toBe(espera);
    },
  );
});

describe('M-3: retención por alerta de fraude', () => {
  it('un pedido pago retenido por fraude espera: no sale', () => {
    expect(
      esperaPagoOnline({
        paymentMethod: PaymentMethod.MERCADOPAGO,
        paymentStatus: PaymentStatus.PAID,
        paymentFraudHold: true,
      }),
    ).toBe(true);
  });

  it('una reserva con la seña paga retenida por fraude también espera', () => {
    expect(
      esperaPagoOnline({
        paymentMethod: PaymentMethod.MERCADOPAGO,
        paymentStatus: PaymentStatus.PENDING,
        depositPaid: true,
        paymentFraudHold: true,
      }),
    ).toBe(true);
  });

  it('sin retención todo sigue como antes', () => {
    expect(
      esperaPagoOnline({
        paymentMethod: PaymentMethod.MERCADOPAGO,
        paymentStatus: PaymentStatus.PAID,
        paymentFraudHold: false,
      }),
    ).toBe(false);
  });
});

describe('M-1: mensaje 409 de un pedido que espera', () => {
  it('retenido por fraude tiene su propio mensaje: no dice «todavía no está pago»', () => {
    const m = mensajeDeEspera({
      paymentMethod: PaymentMethod.MERCADOPAGO,
      paymentStatus: PaymentStatus.PAID,
      paymentFraudHold: true,
    });
    expect(m).toBe(MENSAJE_RETENIDO_POR_FRAUDE);
    expect(m).not.toContain('todavía no está pago');
  });

  it('sin retención, el de siempre', () => {
    expect(
      mensajeDeEspera({
        paymentMethod: PaymentMethod.MERCADOPAGO,
        paymentStatus: PaymentStatus.PENDING,
      }),
    ).toBe(MENSAJE_MP_SIN_PAGAR);
  });
});
