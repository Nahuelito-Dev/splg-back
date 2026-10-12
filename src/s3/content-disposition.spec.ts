import { contentDisposition, disposicionSegura } from './content-disposition';

describe('contentDisposition', () => {
  it("codifica también ' ( ) * en filename* (RFC 5987)", () => {
    const valor = contentDisposition("o'brien (1)*.pdf");
    expect(valor).toContain("filename*=UTF-8''o%27brien%20%281%29%2A.pdf");
  });

  it('deja una versión ASCII sin comillas ni acentos', () => {
    expect(contentDisposition('póliza "x".pdf')).toContain(
      'filename="p_liza _x_.pdf"',
    );
  });
});

describe('contentDisposition con disposición', () => {
  it('por defecto es attachment; inline se respeta', () => {
    expect(contentDisposition('a.pdf')).toMatch(/^attachment;/);
    expect(contentDisposition('a.pdf', 'inline')).toMatch(/^inline;/);
  });
});

describe('disposicionSegura', () => {
  it.each([
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'IMAGE/PNG; charset=binary',
  ])('inline para %s si lo piden', (tipo) => {
    expect(disposicionSegura('inline', tipo)).toBe('inline');
  });

  it.each([
    'text/html',
    'text/html; charset=utf-8',
    'image/svg+xml',
    'application/xhtml+xml',
    'text/xml',
    'application/javascript',
    'application/octet-stream',
    'desconocido',
    '',
  ])('fuerza attachment para %s aunque pidan inline', (tipo) => {
    expect(disposicionSegura('inline', tipo)).toBe('attachment');
  });

  it('sin pedido, o sin tipo, es attachment', () => {
    expect(disposicionSegura(undefined, 'image/png')).toBe('attachment');
    expect(disposicionSegura('attachment', 'image/png')).toBe('attachment');
    expect(disposicionSegura('inline', undefined)).toBe('attachment');
  });
});
