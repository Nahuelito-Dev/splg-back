import { alcanzaElStock } from './stock-del-camion-alcanza';

describe('alcanzaElStock', () => {
  const lleva = new Map([
    ['g10', 3],
    ['g15', 1],
  ]);

  it('alcanza cuando cubre cada renglón, justo o con sobra', () => {
    expect(
      alcanzaElStock(lleva, [
        { gasCylinderId: 'g10', quantity: 3 },
        { gasCylinderId: 'g15', quantity: 1 },
      ]),
    ).toBe(true);
  });

  it('no alcanza si un solo renglón queda corto', () => {
    expect(
      alcanzaElStock(lleva, [
        { gasCylinderId: 'g10', quantity: 1 },
        { gasCylinderId: 'g15', quantity: 2 },
      ]),
    ).toBe(false);
  });

  it('un tipo que el camión no lleva cuenta como cero', () => {
    expect(alcanzaElStock(lleva, [{ gasCylinderId: 'g45', quantity: 1 }])).toBe(
      false,
    );
  });

  it('sin renglones alcanza', () => {
    expect(alcanzaElStock(new Map(), [])).toBe(true);
  });
});
