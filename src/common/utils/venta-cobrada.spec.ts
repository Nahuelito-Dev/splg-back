import { esVentaCobrada, ventaCobradaWhere } from './venta-cobrada';
import {
  PaymentMethod,
  PaymentStatus,
} from '../../order/entities/order.entity';

describe('esVentaCobrada', () => {
  const caso = (s: PaymentStatus, m: PaymentMethod) =>
    esVentaCobrada({ paymentStatus: s, paymentMethod: m });

  it('paid cuenta en cualquier medio', () => {
    expect(caso(PaymentStatus.PAID, PaymentMethod.CASH)).toBe(true);
    expect(caso(PaymentStatus.PAID, PaymentMethod.MERCADOPAGO)).toBe(true);
  });
  it('pending cuenta si no es efectivo', () => {
    expect(caso(PaymentStatus.PENDING, PaymentMethod.TRANSFER)).toBe(true);
    expect(caso(PaymentStatus.PENDING, PaymentMethod.MERCADOPAGO)).toBe(true);
  });
  it('efectivo pendiente, impago y pérdida no cuentan', () => {
    expect(caso(PaymentStatus.PENDING, PaymentMethod.CASH)).toBe(false);
    expect(caso(PaymentStatus.UNPAID, PaymentMethod.CASH)).toBe(false);
    expect(caso(PaymentStatus.WRITTEN_OFF, PaymentMethod.CASH)).toBe(false);
  });
  it('el where conserva la base en las dos alternativas', () => {
    const w = ventaCobradaWhere({ distributorId: 'd1' });
    expect(w).toHaveLength(2);
    expect(w.every((x) => x.distributorId === 'd1')).toBe(true);
  });
});
