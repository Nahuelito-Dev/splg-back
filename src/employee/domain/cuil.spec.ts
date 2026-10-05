import { esCuilValido, normalizarCuil } from './cuil';

describe('CUIL', () => {
  it.each(['20123456786', '27234567891', '23123456785', '20100000025'])(
    '%s es válido',
    (cuil) => {
      expect(esCuilValido(cuil)).toBe(true);
    },
  );

  it('rechaza un dígito verificador incorrecto', () => {
    expect(esCuilValido('20123456785')).toBe(false);
    expect(esCuilValido('20123456787')).toBe(false);
  });

  it.each(['', '2012345678', '201234567860', '2012345678a', '20-12345678-6'])(
    'rechaza el formato "%s"',
    (cuil) => {
      expect(esCuilValido(cuil)).toBe(false);
    },
  );

  it('rechaza un prefijo que no es de persona humana', () => {
    expect(esCuilValido('99123456788')).toBe(false);
    expect(esCuilValido('30123456786')).toBe(false);
  });

  it('rechaza el caso en que el verificador daría 10 (no existe)', () => {
    // El cuerpo 20-00000001 da resto 1: ningún dígito lo completa.
    for (let d = 0; d <= 9; d++) {
      expect(esCuilValido(`2000000001${d}`)).toBe(false);
    }
  });

  it('normaliza guiones y espacios', () => {
    expect(normalizarCuil('20-12345678-6')).toBe('20123456786');
    expect(normalizarCuil(' 20 12345678 6 ')).toBe('20123456786');
  });
});
