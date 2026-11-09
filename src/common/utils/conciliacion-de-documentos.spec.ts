import { ConflictException } from '@nestjs/common';
import {
  assertDuenoSinCambios,
  dinero,
  esImporteIgual,
} from './conciliacion-de-documentos';

describe('conciliación de documentos', () => {
  it('dinero deja dos decimales y respeta el nulo', () => {
    expect(dinero(100)).toBe('100.00');
    expect(dinero(null)).toBeNull();
  });

  it('el importe se compara con la tolerancia y vacío nunca coincide', () => {
    expect(esImporteIgual('100.00', '101.00', 1)).toBe(true);
    expect(esImporteIgual('100.00', '101.01', 1)).toBe(false);
    expect(esImporteIgual('0.00', '0.00', 1)).toBe(true);
    expect(esImporteIgual('0.00', '1.00', 50)).toBe(false);
    expect(esImporteIgual(null, '1.00', 1)).toBe(false);
    expect(esImporteIgual('1.00', null, 1)).toBe(false);
    expect(esImporteIgual('x', '1.00', 1)).toBe(false);
  });

  it('un valor distinto del esperado es 409; lo no registrado no se compara', () => {
    expect(() =>
      assertDuenoSinCambios({ total: '1.00' }, { total: '2.00' }),
    ).toThrow(ConflictException);
    expect(() =>
      assertDuenoSinCambios({ total: null }, { total: null }),
    ).not.toThrow();
    expect(() => assertDuenoSinCambios({}, { total: '2.00' })).not.toThrow();
  });
});
