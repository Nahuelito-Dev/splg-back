import { acotar, aWinAnsi } from './pdf-formato';

describe('aWinAnsi', () => {
  it('deja intacto lo que la fuente del PDF puede dibujar', () => {
    expect(aWinAnsi('Ñandú, café y €1.500 «ok» — 2ª\nlínea')).toBe(
      'Ñandú, café y €1.500 «ok» — 2ª\nlínea',
    );
  });

  it('a las letras que no tiene les quita el signo', () => {
    expect(aWinAnsi('Łódź, Đorđe y Čapek')).toBe('Lódz, Dorde y Capek');
  });

  it('el tab es un espacio, los fines de línea quedan en «\\n» y lo invisible se descarta', () => {
    expect(aWinAnsi('a\tb\r\nc\rd')).toBe('a b\nc\nd');
    expect(aWinAnsi('x\u0301 ok')).toBe('x ok');
    expect(aWinAnsi('Bien ❤️ 👍🏽')).toBe('Bien ? ??');
  });

  it('reemplaza emojis y otros alfabetos por «?»', () => {
    expect(aWinAnsi('Gas 🔥 北京')).toBe('Gas ? ??');
  });
});

describe('acotar', () => {
  it('no toca un texto corto', () => {
    expect(acotar('Faltó un vuelto', 300)).toBe('Faltó un vuelto');
  });

  it('corta un texto largo al tope con «…» y también lo sanea', () => {
    const acotado = acotar(`${'a'.repeat(400)} 🔥`, 300);
    expect(acotado).toHaveLength(300);
    expect(acotado.endsWith('…')).toBe(true);
  });
});
