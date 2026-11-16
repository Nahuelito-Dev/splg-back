import { esCuitValido, normalizarCuit } from './cuit';

describe('CUIT', () => {
  it('normaliza guiones y espacios', () => {
    expect(normalizarCuit('30-71234567-1')).toBe('30712345671');
    expect(normalizarCuit('30 71234567 1')).toBe('30712345671');
  });

  it.each(['30712345671', '30709988774', '20123456786', '27234567891'])(
    'acepta %s',
    (cuit) => expect(esCuitValido(cuit)).toBe(true),
  );

  it.each([
    ['dígito verificador incorrecto', '30712345672'],
    ['prefijo inexistente', '10712345671'],
    ['corto', '3071234567'],
    ['con letras', '3071234567a'],
    ['vacío', ''],
  ])('rechaza %s', (_motivo, cuit) => expect(esCuitValido(cuit)).toBe(false));
});
