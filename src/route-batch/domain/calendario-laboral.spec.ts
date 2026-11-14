import {
  CALENDARIO_POR_OMISION,
  diaDeLaSemana,
  diaHabilSiguiente,
  diasDeLaMascara,
  esDiaHabil,
  sumarDias,
} from './calendario-laboral';

describe('calendario laboral', () => {
  it('la máscara de días ISO: 63 es lunes a sábado; 31, lunes a viernes; 64, sólo domingo', () => {
    expect([...diasDeLaMascara(63)]).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...diasDeLaMascara(31)]).toEqual([1, 2, 3, 4, 5]);
    expect([...diasDeLaMascara(64)]).toEqual([7]);
    expect([...diasDeLaMascara(1 + 4 + 16)]).toEqual([1, 3, 5]);
  });

  it('día de la semana ISO y suma de días (cruza de año)', () => {
    expect(diaDeLaSemana('2026-11-16')).toBe(1); // lunes
    expect(diaDeLaSemana('2026-11-15')).toBe(7); // domingo
    expect(sumarDias('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('día hábil: por omisión lunes a sábado sin feriados; un feriado no es hábil', () => {
    expect(esDiaHabil('2026-11-14', CALENDARIO_POR_OMISION)).toBe(true);
    expect(esDiaHabil('2026-11-15', CALENDARIO_POR_OMISION)).toBe(false);
    expect(
      esDiaHabil('2026-11-16', {
        diasHabiles: diasDeLaMascara(63),
        feriados: new Set(['2026-11-16']),
      }),
    ).toBe(false);
  });

  it('el siguiente hábil saltea días no hábiles y feriados seguidos', () => {
    expect(diaHabilSiguiente('2026-11-14')).toBe('2026-11-16');
    const cal = {
      diasHabiles: diasDeLaMascara(31),
      feriados: new Set(['2026-11-23', '2026-11-24']),
    };
    // Viernes 20 → sábado y domingo no, lunes 23 y martes 24 feriados → miércoles 25.
    expect(diaHabilSiguiente('2026-11-20', cal)).toBe('2026-11-25');
    // Sólo domingos: del lunes 16 al domingo 22.
    expect(
      diaHabilSiguiente('2026-11-16', {
        diasHabiles: diasDeLaMascara(64),
        feriados: new Set(),
      }),
    ).toBe('2026-11-22');
  });

  it('sin ningún día hábil en el tope, el día siguiente', () => {
    expect(
      diaHabilSiguiente('2026-11-16', {
        diasHabiles: new Set(),
        feriados: new Set(),
      }),
    ).toBe('2026-11-17');
  });
});
