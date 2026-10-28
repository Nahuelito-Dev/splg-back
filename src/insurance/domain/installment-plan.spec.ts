import { generarCuotas, vencimientoDeLaCuota } from './installment-plan';

describe('vencimientoDeLaCuota', () => {
  it('cae el mismo día de cada mes', () => {
    expect(vencimientoDeLaCuota('2026-06-22', 0)).toBe('2026-06-22');
    expect(vencimientoDeLaCuota('2026-06-22', 5)).toBe('2026-11-22');
  });

  it('cruza el año', () => {
    expect(vencimientoDeLaCuota('2026-11-15', 2)).toBe('2027-01-15');
    expect(vencimientoDeLaCuota('2026-12-10', 1)).toBe('2027-01-10');
    expect(vencimientoDeLaCuota('2026-12-10', 13)).toBe('2028-01-10');
  });

  it('si el mes no tiene el día, cae el último, y el día original se recupera después', () => {
    expect(vencimientoDeLaCuota('2026-10-31', 1)).toBe('2026-11-30');
    expect(vencimientoDeLaCuota('2026-10-31', 2)).toBe('2026-12-31');
    expect(vencimientoDeLaCuota('2026-10-31', 4)).toBe('2027-02-28');
    expect(vencimientoDeLaCuota('2026-10-31', 5)).toBe('2027-03-31');
  });

  it('febrero de un año bisiesto tiene 29', () => {
    expect(vencimientoDeLaCuota('2027-12-30', 2)).toBe('2028-02-29');
    expect(vencimientoDeLaCuota('2028-01-29', 1)).toBe('2028-02-29');
    expect(vencimientoDeLaCuota('2027-01-29', 1)).toBe('2027-02-28');
  });
});

describe('generarCuotas', () => {
  it('el plan del documento real: 6 cuotas de 29958 el 22 con gracia hasta el 27', () => {
    const cuotas = generarCuotas({
      count: 6,
      amount: 29958,
      firstDueDate: '2026-06-22',
      graceDays: 5,
    });
    expect(cuotas.map((c) => c.dueDate)).toEqual([
      '2026-06-22',
      '2026-07-22',
      '2026-08-22',
      '2026-09-22',
      '2026-10-22',
      '2026-11-22',
    ]);
    expect(
      cuotas.every(
        (c, i) =>
          c.graceUntil === c.dueDate.replace(/22$/, '27') &&
          c.number === i + 1 &&
          c.total === 6,
      ),
    ).toBe(true);
    expect(cuotas.every((c) => c.amount.eq(29958))).toBe(true);
  });

  it('la gracia que cruza el fin de mes pasa al mes siguiente', () => {
    const [c] = generarCuotas({
      count: 1,
      amount: '100.50',
      firstDueDate: '2026-12-29',
      graceDays: 5,
    });
    expect(c.graceUntil).toBe('2027-01-03');
    expect(c.amount.toFixed(2)).toBe('100.50');
  });

  it('con 0 días de gracia, la gracia es el vencimiento', () => {
    const [c] = generarCuotas({
      count: 1,
      amount: 10,
      firstDueDate: '2026-12-29',
      graceDays: 0,
    });
    expect(c.graceUntil).toBe(c.dueDate);
  });
});
