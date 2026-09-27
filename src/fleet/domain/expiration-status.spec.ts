import {
  calcularEstadoDeVencimiento,
  diasHastaElVencimiento,
  ExpirationStatus,
} from './expiration-status';

describe('calcularEstadoDeVencimiento', () => {
  const ahora = new Date('2026-09-26T12:00:00Z');

  it('sin fecha límite no hay estado que calcular', () => {
    expect(calcularEstadoDeVencimiento(null, 30, ahora)).toBeNull();
  });

  it('vigente: falta más que el lead time', () => {
    const dueAt = new Date('2026-12-01T00:00:00Z');
    expect(calcularEstadoDeVencimiento(dueAt, 30, ahora)).toBe(
      ExpirationStatus.CURRENT,
    );
  });

  it('por vencer: dentro de la ventana de anticipación', () => {
    const dueAt = new Date('2026-10-10T00:00:00Z'); // 14 días de hoy
    expect(calcularEstadoDeVencimiento(dueAt, 30, ahora)).toBe(
      ExpirationStatus.DUE_SOON,
    );
  });

  it('vencido: la fecha límite ya pasó', () => {
    const dueAt = new Date('2026-09-01T00:00:00Z');
    expect(calcularEstadoDeVencimiento(dueAt, 30, ahora)).toBe(
      ExpirationStatus.EXPIRED,
    );
  });

  it('el límite exacto de la ventana ya es "por vencer"', () => {
    const dueAt = new Date('2026-10-26T12:00:00Z'); // exactamente 30 días
    expect(calcularEstadoDeVencimiento(dueAt, 30, ahora)).toBe(
      ExpirationStatus.DUE_SOON,
    );
  });

  it('el instante mismo del vencimiento todavía no es "vencido"', () => {
    expect(calcularEstadoDeVencimiento(ahora, 30, ahora)).toBe(
      ExpirationStatus.DUE_SOON,
    );
  });
});

describe('diasHastaElVencimiento', () => {
  const ahora = new Date('2026-09-26T00:00:00Z');

  it('null sin fecha límite', () => {
    expect(diasHastaElVencimiento(null, ahora)).toBeNull();
  });

  it('positivo si falta', () => {
    expect(
      diasHastaElVencimiento(new Date('2026-10-06T00:00:00Z'), ahora),
    ).toBe(10);
  });

  it('negativo si ya venció', () => {
    expect(
      diasHastaElVencimiento(new Date('2026-09-16T00:00:00Z'), ahora),
    ).toBe(-10);
  });
});
