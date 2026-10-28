import { origenDeSocketPermitido, origenesPermitidos } from './cors-origins';

describe('orígenes permitidos', () => {
  it('lee la lista separada por comas, sin espacios ni vacíos', () => {
    expect(origenesPermitidos(' http://a , ,http://b ')).toEqual([
      'http://a',
      'http://b',
    ]);
    expect(origenesPermitidos(undefined)).toEqual([]);
  });

  it('el socket admite las apps sin Origin y sólo las páginas de la lista', () => {
    const lista = ['http://localhost:3001'];
    expect(origenDeSocketPermitido(undefined, lista)).toBe(true);
    expect(origenDeSocketPermitido('http://localhost:3001', lista)).toBe(true);
    expect(origenDeSocketPermitido('https://otra.com', lista)).toBe(false);
    expect(origenDeSocketPermitido('http://localhost:3001', [])).toBe(false);
  });
});
