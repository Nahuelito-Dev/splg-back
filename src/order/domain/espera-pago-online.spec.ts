import { PaymentMethod, PaymentStatus } from '../entities/order.entity';
import { esperaPagoOnline } from './espera-pago-online';

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
