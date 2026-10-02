import { normalizarEmail } from './email.util';

describe('normalizarEmail', () => {
  it('pasa a minúsculas y recorta', () => {
    expect(normalizarEmail('  Ana.Perez@Mail.COM ')).toBe('ana.perez@mail.com');
  });
});
