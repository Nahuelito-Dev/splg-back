import {
  claveDelNombre,
  nombreDeEtiqueta,
  nombreDeEtiquetaValido,
} from './etiquetas';

describe('etiquetas de la bandeja (7c)', () => {
  it('el nombre se guarda recortado y con los espacios de adentro de a uno', () => {
    expect(nombreDeEtiqueta('  Reclamo   de  envío ')).toBe('Reclamo de envío');
  });

  it('de 1 a 30 caracteres contados como letras, en una sola línea', () => {
    expect(nombreDeEtiquetaValido('A')).toBe(true);
    expect(nombreDeEtiquetaValido('x'.repeat(30))).toBe(true);
    expect(nombreDeEtiquetaValido('x'.repeat(31))).toBe(false);
    expect(nombreDeEtiquetaValido('   ')).toBe(false);
    expect(nombreDeEtiquetaValido('')).toBe(false);
    // 30 emojis son 60 unidades UTF-16 pero 30 caracteres, como en la base.
    expect(nombreDeEtiquetaValido('🔥'.repeat(30))).toBe(true);
    expect(nombreDeEtiquetaValido('Dos\nlíneas')).toBe(false);
    expect(nombreDeEtiquetaValido('Con separador')).toBe(false);
    expect(nombreDeEtiquetaValido('Con\u0007control')).toBe(false);
  });

  it('la clave no distingue mayúsculas ni tildes', () => {
    expect(claveDelNombre('Envíos')).toBe(claveDelNombre('ENVIOS'));
    expect(claveDelNombre(' Atención  urgente')).toBe('atencion urgente');
    expect(claveDelNombre('Pagos')).not.toBe(claveDelNombre('Pago'));
  });
});
