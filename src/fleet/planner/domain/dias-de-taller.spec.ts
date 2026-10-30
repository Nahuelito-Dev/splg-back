import {
  DIAS_DE_TALLER_POR_OMISION,
  FERIADOS_AR,
  diasDeLaMascara,
  esDiaDeTaller,
  esFeriado,
} from './dias-de-taller';

describe('días de taller', () => {
  it('por omisión atiende de lunes a sábado', () => {
    expect(diasDeLaMascara(DIAS_DE_TALLER_POR_OMISION)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it('la máscara elige los días: bit n = día n (0 domingo)', () => {
    expect(diasDeLaMascara(0b1000001)).toEqual([0, 6]);
    expect(diasDeLaMascara(127)).toHaveLength(7);
  });

  it('un domingo no es día de taller por omisión, pero sí si se habilita', () => {
    // 01/11/2026 es domingo.
    expect(esDiaDeTaller('2026-11-01', DIAS_DE_TALLER_POR_OMISION)).toBe(false);
    expect(esDiaDeTaller('2026-11-01', 127)).toBe(true);
    expect(esDiaDeTaller('2026-11-02', DIAS_DE_TALLER_POR_OMISION)).toBe(true);
  });

  it('un feriado nacional no es día de taller aunque sea un día habilitado', () => {
    expect(esFeriado('2026-12-25')).toBe(true);
    expect(esDiaDeTaller('2026-12-25', 127)).toBe(false); // viernes
    expect(esDiaDeTaller('2026-12-24', DIAS_DE_TALLER_POR_OMISION)).toBe(true);
  });

  it('la lista cubre 2026 y 2027, sin repetidos ni fechas mal escritas', () => {
    const anios = new Set([...FERIADOS_AR].map((d) => d.slice(0, 4)));
    expect(anios).toEqual(new Set(['2026', '2027']));
    for (const d of FERIADOS_AR) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(FERIADOS_AR.size).toBeGreaterThanOrEqual(25);
  });
});
