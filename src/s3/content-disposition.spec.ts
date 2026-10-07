import { contentDisposition } from './content-disposition';

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
