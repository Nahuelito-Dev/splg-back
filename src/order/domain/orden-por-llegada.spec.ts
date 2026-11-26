import { ordenarPorLlegada } from './orden-por-llegada';

describe('ordenarPorLlegada', () => {
  it('ordena por minutos de menor a mayor', () => {
    const m = new Map([
      ['a', 10],
      ['b', 3],
      ['c', 7],
    ]);
    expect(ordenarPorLlegada(['a', 'b', 'c'], m)).toEqual(['b', 'c', 'a']);
  });

  it('los sin estimación quedan después, en el orden del radar', () => {
    const m = new Map([['c', 20]]);
    expect(ordenarPorLlegada(['a', 'b', 'c', 'd'], m)).toEqual([
      'c',
      'a',
      'b',
      'd',
    ]);
  });

  it('a igualdad de minutos conserva el orden del radar', () => {
    const m = new Map([
      ['a', 5],
      ['b', 5],
      ['c', 5],
    ]);
    expect(ordenarPorLlegada(['c', 'a', 'b'], m)).toEqual(['c', 'a', 'b']);
  });

  it('ignora minutos no finitos', () => {
    const m = new Map([
      ['a', Number.NaN],
      ['b', 4],
    ]);
    expect(ordenarPorLlegada(['a', 'b'], m)).toEqual(['b', 'a']);
  });

  it('sin estimaciones devuelve el orden del radar y no toca la entrada', () => {
    const entrada = ['x', 'y'];
    expect(ordenarPorLlegada(entrada, new Map())).toEqual(['x', 'y']);
    expect(entrada).toEqual(['x', 'y']);
  });
});
