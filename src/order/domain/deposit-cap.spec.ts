import { BadRequestException } from '@nestjs/common';
import {
  assertSenaConMercadoPago,
  assertSenaNoSuperaTotal,
  saldoTrasLaSena,
  totalBajoLaSenaPagada,
} from './deposit-cap';
import { PaymentMethod } from '../entities/order.entity';

describe('assertSenaNoSuperaTotal', () => {
  it('rechaza una seña mayor al total, con los dos montos', () => {
    expect(() => assertSenaNoSuperaTotal(5000, 3000)).toThrow(
      new BadRequestException(
        'La seña ($5000.00) no puede superar el total del pedido ($3000.00)',
      ),
    );
  });

  it('acepta la seña igual al total y la menor', () => {
    expect(() => assertSenaNoSuperaTotal(3000, 3000)).not.toThrow();
    expect(() => assertSenaNoSuperaTotal(0, 3000)).not.toThrow();
  });

  it('compara con el total redondeado a 2 decimales, como lo guarda la base', () => {
    expect(() => assertSenaNoSuperaTotal(100.01, '100.005')).not.toThrow();
    expect(() => assertSenaNoSuperaTotal(100.02, '100.005')).toThrow(
      BadRequestException,
    );
  });
});

describe('totalBajoLaSenaPagada', () => {
  it('compara con el total redondeado: 100.089 se guarda como 100.09', () => {
    expect(totalBajoLaSenaPagada('100.089', 100.09)).toBe(false);
    expect(totalBajoLaSenaPagada('100.089', 100.1)).toBe(true);
    expect(totalBajoLaSenaPagada('100.085', 100.09)).toBe(false);
  });
});

describe('assertSenaConMercadoPago', () => {
  it.each([[undefined], [null], [0], [0.001], [0.004]])(
    'con MercadoPago una seña %s es 400',
    (sena) => {
      expect(() =>
        assertSenaConMercadoPago(PaymentMethod.MERCADOPAGO, sena),
      ).toThrow(BadRequestException);
    },
  );

  it('con MercadoPago acepta una seña mayor a cero', () => {
    expect(() =>
      assertSenaConMercadoPago(PaymentMethod.MERCADOPAGO, 0.01),
    ).not.toThrow();
  });

  it('con otros medios no exige seña', () => {
    for (const medio of [
      PaymentMethod.CASH,
      PaymentMethod.TRANSFER,
      PaymentMethod.ACCOUNT,
    ]) {
      expect(() => assertSenaConMercadoPago(medio, 0)).not.toThrow();
    }
  });
});

describe('saldoTrasLaSena', () => {
  it('es el total menos la seña, a 2 decimales', () => {
    expect(saldoTrasLaSena(16700, 500).toNumber()).toBe(16200);
    expect(saldoTrasLaSena(0.3, 0.1).toNumber()).toBe(0.2);
    expect(saldoTrasLaSena('100.09', 0).toNumber()).toBe(100.09);
  });

  it('con la seña igual al total no queda saldo', () => {
    expect(saldoTrasLaSena(5000, 5000).toNumber()).toBe(0);
  });
});
