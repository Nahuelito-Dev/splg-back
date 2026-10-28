import {
  ALIAS_BANCARIO_REGEX,
  cbuValidoSql,
  esCbuValido,
} from './datos-bancarios';

describe('datos-bancarios', () => {
  describe('esCbuValido', () => {
    it('acepta un CBU con los dos dígitos verificadores correctos', () => {
      expect(esCbuValido('0170099220000067797370')).toBe(true);
    });

    it('rechaza el verificador del segundo bloque', () => {
      expect(esCbuValido('0170099220000067797371')).toBe(false);
    });

    it('rechaza el verificador del primer bloque', () => {
      expect(esCbuValido('0170098220000067797370')).toBe(false);
    });

    it.each([
      '',
      '017009922000006779737',
      '01700992200000677973700',
      'a'.repeat(22),
    ])('rechaza "%s" por formato', (cbu) => {
      expect(esCbuValido(cbu)).toBe(false);
    });
  });

  describe('ALIAS_BANCARIO_REGEX', () => {
    it.each(['mi.alias', 'GAS-SPLG.01', 'a'.repeat(20), 'abcdef'])(
      '"%s" es válido',
      (alias) => {
        expect(ALIAS_BANCARIO_REGEX.test(alias)).toBe(true);
      },
    );

    it.each([
      'corto',
      'a'.repeat(21),
      'con espacio',
      'ñandu.gas',
      'a_b_c_d',
      '',
    ])('"%s" es inválido', (alias) => {
      expect(ALIAS_BANCARIO_REGEX.test(alias)).toBe(false);
    });
  });

  it('cbuValidoSql nombra la columna y controla los dos verificadores', () => {
    const sql = cbuValidoSql('"bank_cbu"');
    expect(sql).toContain('"bank_cbu" IS NULL');
    expect(sql).toContain('substr("bank_cbu", 8, 1)::int');
    expect(sql).toContain('substr("bank_cbu", 22, 1)::int');
  });
});
