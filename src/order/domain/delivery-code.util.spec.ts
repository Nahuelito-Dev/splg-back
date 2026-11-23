import {
  esCodigoDeSeisDigitos,
  compareDeliveryCode,
  generateDeliveryCode,
  tieneFormatoDeCodigo,
} from './delivery-code.util';

describe('compareDeliveryCode', () => {
  it('no distingue mayúsculas de minúsculas', () => {
    expect(compareDeliveryCode('A1B2C3D4E5', 'a1b2c3d4e5')).toBe(true);
    expect(compareDeliveryCode('a1b2c3d4e5', 'A1B2C3D4E5')).toBe(true);
  });

  it('rechaza un código distinto, de otro largo o vacío', () => {
    expect(compareDeliveryCode('A1B2C3D4E5', 'A1B2C3D4E6')).toBe(false);
    expect(compareDeliveryCode('A1B2C3D4E5', 'A1B2')).toBe(false);
    expect(compareDeliveryCode(null, 'A1B2C3D4E5')).toBe(false);
    expect(compareDeliveryCode('A1B2C3D4E5', '')).toBe(false);
  });
});

describe('tieneFormatoDeCodigo', () => {
  it('acepta alfanuméricos de 4 a 12 (también los de 6 dígitos del seed) y rechaza el resto', () => {
    expect(tieneFormatoDeCodigo('A1B2C3D4E5')).toBe(true);
    expect(tieneFormatoDeCodigo('a1b2c3d4e5')).toBe(true);
    expect(tieneFormatoDeCodigo('123456')).toBe(true);
    expect(tieneFormatoDeCodigo('ABC')).toBe(false);
    expect(tieneFormatoDeCodigo('A1B2C3D4E5F6G')).toBe(false);
    expect(tieneFormatoDeCodigo('https://x.com')).toBe(false);
  });
});

describe('generateDeliveryCode', () => {
  it('genera 6 dígitos, con ceros a la izquierda si hace falta', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateDeliveryCode()).toMatch(/^\d{6}$/);
    }
  });

  it('no repite siempre el mismo', () => {
    const codigos = new Set(
      Array.from({ length: 50 }, () => generateDeliveryCode()),
    );
    expect(codigos.size).toBeGreaterThan(40);
  });
});

describe('esCodigoDeSeisDigitos', () => {
  it('acepta sólo 6 dígitos', () => {
    expect(esCodigoDeSeisDigitos('482913')).toBe(true);
    expect(esCodigoDeSeisDigitos('000000')).toBe(true);
    expect(esCodigoDeSeisDigitos('48291')).toBe(false);
    expect(esCodigoDeSeisDigitos('4829133')).toBe(false);
    expect(esCodigoDeSeisDigitos('48A913')).toBe(false);
    expect(esCodigoDeSeisDigitos('A1B2C3D4E5')).toBe(false);
    expect(esCodigoDeSeisDigitos('')).toBe(false);
  });
});
