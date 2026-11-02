import { saldoPendiente, saldoPendienteSql } from './saldo-pendiente';

describe('saldo pendiente de un pedido', () => {
  it('descuenta la seña sólo si ya está paga', () => {
    expect(saldoPendiente(1000, 300, true).toNumber()).toBe(700);
    expect(saldoPendiente(1000, 300, false).toNumber()).toBe(1000);
  });

  it('redondea a 2 decimales como la base', () => {
    expect(saldoPendiente(100.089, 0, false).toNumber()).toBe(100.09);
  });

  it('la expresión SQL usa el mismo criterio', () => {
    expect(saldoPendienteSql('order')).toBe(
      '(order.totalAmount - CASE WHEN order.depositPaid THEN order.depositAmount ELSE 0 END)',
    );
  });
});
