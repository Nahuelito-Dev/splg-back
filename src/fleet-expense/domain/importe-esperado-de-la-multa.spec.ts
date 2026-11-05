import { importeEsperadoDeLaMulta } from './importe-esperado-de-la-multa';

describe('importeEsperadoDeLaMulta', () => {
  const multa = {
    amount: 100,
    voluntaryPaymentAmount: 80,
    dueDate: '2026-01-10',
  };

  it('usa el pago voluntario solamente mientras está vigente', () => {
    expect(importeEsperadoDeLaMulta(multa, '2026-01-10')).toBe('80.00');
    expect(importeEsperadoDeLaMulta(multa, '2026-01-11')).toBe('100.00');
  });
});
