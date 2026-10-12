import { esVentaCobrada, ventaCobradaWhere } from './venta-cobrada';
import { PaymentStatus } from '../../order/entities/order.entity';

describe('esVentaCobrada', () => {
  it('sólo paid cuenta, cualquiera sea el medio', () => {
    expect(esVentaCobrada({ paymentStatus: PaymentStatus.PAID })).toBe(true);
  });
  it.each([
    PaymentStatus.PENDING,
    PaymentStatus.UNPAID,
    PaymentStatus.WRITTEN_OFF,
    PaymentStatus.FAILED,
  ])('%s no cuenta (transferencia o MP pendiente incluidos)', (s) => {
    expect(esVentaCobrada({ paymentStatus: s })).toBe(false);
  });
  it('el where conserva la base y exige paid', () => {
    const w = ventaCobradaWhere({ distributorId: 'd1' });
    expect(w).toEqual([
      { distributorId: 'd1', paymentStatus: PaymentStatus.PAID },
    ]);
  });
});
