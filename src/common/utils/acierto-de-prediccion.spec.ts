import { errorEnDias, resumirAcierto } from './acierto-de-prediccion';

describe('errorEnDias', () => {
  it('es positivo si ocurrió después de lo predicho', () => {
    expect(
      errorEnDias(
        new Date('2026-11-10T15:00:00Z'),
        new Date('2026-11-14T15:00:00Z'),
      ),
    ).toBe(4);
  });
  it('es negativo si ocurrió antes y cero el mismo día argentino', () => {
    expect(
      errorEnDias(
        new Date('2026-11-10T15:00:00Z'),
        new Date('2026-11-08T15:00:00Z'),
      ),
    ).toBe(-2);
    expect(
      errorEnDias(
        new Date('2026-11-10T13:00:00Z'),
        new Date('2026-11-11T01:00:00Z'),
      ),
    ).toBe(0);
  });
});

describe('resumirAcierto', () => {
  it('sin medidas devuelve nulos', () => {
    expect(resumirAcierto([], 3)).toEqual({
      measured: 0,
      meanAbsoluteErrorDays: null,
      withinMarginRate: null,
      marginDays: 3,
      meanBiasDays: null,
    });
  });
  it('calcula MAE, porcentaje dentro del margen y sesgo con signo', () => {
    expect(resumirAcierto([2, -4, 0, 6], 3)).toEqual({
      measured: 4,
      meanAbsoluteErrorDays: 3,
      withinMarginRate: 0.5,
      marginDays: 3,
      meanBiasDays: 1,
    });
  });
});
