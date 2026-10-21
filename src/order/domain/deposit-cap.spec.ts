import { BadRequestException } from '@nestjs/common';
import { assertSenaNoSuperaTotal, totalBajoLaSenaPagada } from './deposit-cap';

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
