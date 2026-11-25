import {
  enmascararCorreo,
  enmascararToken,
  normalizarTipo,
  recortarError,
  recortarTitulo,
  TIPO_SIN_DATO,
} from './aviso';

describe('enmascarado de destinos', () => {
  it('el correo deja la primera letra y el dominio', () => {
    expect(enmascararCorreo('nahuel@dominio.com')).toBe('n***@dominio.com');
    expect(enmascararCorreo('  Ana.Lopez@mail.com.ar ')).toBe(
      'A***@mail.com.ar',
    );
  });

  it('un correo sin forma de correo no se muestra', () => {
    expect(enmascararCorreo('sin-arroba')).toBe('***');
    expect(enmascararCorreo('@dominio.com')).toBe('***');
  });

  it('el token deja sólo los últimos 6 caracteres', () => {
    expect(enmascararToken('fXyz123:APA91bEabcdef')).toBe('***abcdef');
    expect(enmascararToken('corto')).toBe('***');
    expect(enmascararToken('fXyz123:APA91bEabcdef')).not.toContain('APA91');
  });
});

describe('normalización de lo que se guarda', () => {
  it('recorta el error y lo deja en una línea', () => {
    const largo = recortarError(new Error(`a\n${'x y '.repeat(200)}`));
    expect(largo).toHaveLength(300);
    expect(largo).not.toContain('\n');
    expect(recortarError('texto suelto')).toBe('texto suelto');
  });

  it('el error del proveedor no guarda correos, tokens completos ni números largos', () => {
    const token = `fXyz123:APA91b${'a'.repeat(120)}`;
    const texto = recortarError(
      new Error(
        `No se pudo enviar a nahuel.perez@dominio.com.ar con ${token}, tel 5491155551234 (reintento 3)`,
      ),
    );
    expect(texto).not.toContain('nahuel');
    expect(texto).not.toContain('@dominio');
    expect(texto).not.toContain('APA91');
    expect(texto).not.toContain('5491155551234');
    expect(texto).toContain('reintento 3');
    expect(texto).toContain('[correo]');
    expect(texto).toContain('[token]');
  });

  it('un teléfono con espacios, guiones o paréntesis tampoco queda en claro', () => {
    const texto = recortarError(
      new Error(
        'Destino +54 9 351 555-1212 o (0351) 555 1212 no válido (reintento 3)',
      ),
    );
    expect(texto).not.toMatch(/555[\s-]?1212/);
    expect(texto).not.toContain('351');
    expect(texto).toContain('reintento 3');
    expect(texto).toContain('[número]');
  });

  it('el tipo vacío queda como UNKNOWN y el largo se corta', () => {
    expect(normalizarTipo(undefined)).toBe(TIPO_SIN_DATO);
    expect(normalizarTipo('  ')).toBe(TIPO_SIN_DATO);
    expect(normalizarTipo('x'.repeat(100))).toHaveLength(60);
  });

  it('el título vacío es null', () => {
    expect(recortarTitulo('  ')).toBeNull();
    expect(recortarTitulo(undefined)).toBeNull();
    expect(recortarTitulo(' Hola ')).toBe('Hola');
  });
});
