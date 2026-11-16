import { dolares, pesos } from './platform.mapper';

describe('PlatformMapper: montos', () => {
  it('pesos suma con decimal.js y redondea a 2 decimales (mitad hacia arriba)', () => {
    expect(pesos(['0.1', '0.2'])).toBe(0.3);
    expect(pesos(['1.005'])).toBe(1.01);
    expect(pesos([])).toBe(0);
    expect(pesos(['999999999.99', '0.01'])).toBe(1000000000);
  });

  it('dólares a 6 decimales', () => {
    expect(dolares(['0.0000005', '0.1'])).toBe(0.100001);
    expect(dolares(['0.1', '0.2'])).toBe(0.3);
  });
});
