import { normalizarPatente } from './patente.util';

describe('normalizarPatente', () => {
  it.each([
    ['ab123cd', 'AB123CD'],
    [' ab 123-cd ', 'AB123CD'],
    ['AB-123-CD', 'AB123CD'],
    ['AB123CD', 'AB123CD'],
  ])('%s -> %s', (entrada, esperada) => {
    expect(normalizarPatente(entrada)).toBe(esperada);
  });
});
