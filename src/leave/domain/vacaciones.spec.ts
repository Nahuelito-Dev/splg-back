import { diasDeVacacionesPorAntiguedad, diasDentroDelAnio } from './vacaciones';

describe('días de vacaciones por antigüedad (LCT art. 150)', () => {
  it.each([
    ['2026-03-01', 2026, 14],
    ['2021-12-31', 2026, 14], // exactamente 5 años: no excede
    ['2021-12-30', 2026, 21],
    ['2016-12-31', 2026, 21], // exactamente 10
    ['2016-12-30', 2026, 28],
    ['2010-12-30', 2026, 28], // 16 años
    ['2006-12-31', 2026, 28], // exactamente 20
    ['2006-12-30', 2026, 35],
    ['1990-01-01', 2026, 35],
    ['2027-01-01', 2026, 0], // ingresa después del cierre
  ])('ingreso %s, año %i: %i días', (ingreso, anio, esperado) => {
    expect(diasDeVacacionesPorAntiguedad(ingreso, anio)).toBe(esperado);
  });

  it('un ingreso un 29/02 no rompe el tramo (los 10 años caen el 01/03 de un año no bisiesto)', () => {
    expect(diasDeVacacionesPorAntiguedad('2016-02-29', 2026)).toBe(28);
    expect(diasDeVacacionesPorAntiguedad('2016-02-29', 2025)).toBe(21);
  });

  it('cuenta sólo los días del período que caen en el año', () => {
    expect(diasDentroDelAnio('2026-12-28', '2027-01-03', 2026)).toBe(4);
    expect(diasDentroDelAnio('2026-12-28', '2027-01-03', 2027)).toBe(3);
    expect(diasDentroDelAnio('2026-03-01', '2026-03-14', 2026)).toBe(14);
    expect(diasDentroDelAnio('2026-03-01', '2026-03-14', 2025)).toBe(0);
  });
});
