import { descriptorDeResumen } from './statement-descriptor';

describe('descriptorDeResumen', () => {
  it('pasa a mayúsculas, sin tildes ni símbolos', () => {
    expect(descriptorDeResumen('Gas Ñandú')).toBe('GAS NANDU');
    expect(descriptorDeResumen('Jeny & Gas, S.R.L.')).toBe('JENY GAS S R');
  });

  it('corta en 13 caracteres sin dejar un espacio al final', () => {
    expect(descriptorDeResumen('Distribuidora Norte')).toBe('DISTRIBUIDORA');
    expect(descriptorDeResumen('Gas del Sur Sa Mas')).toBe('GAS DEL SUR S');
    expect(descriptorDeResumen('Garrafas del Sur')).toBe('GARRAFAS DEL');
  });

  it('sin nada utilizable cae en SPLG', () => {
    expect(descriptorDeResumen()).toBe('SPLG');
    expect(descriptorDeResumen('  ')).toBe('SPLG');
    expect(descriptorDeResumen('***')).toBe('SPLG');
  });
});
