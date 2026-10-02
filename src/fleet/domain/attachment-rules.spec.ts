import {
  decodificarNombreDeArchivo,
  esMimeTypePermitido,
  extensionParaMimeType,
  MAX_ATTACHMENT_SIZE_BYTES,
} from './attachment-rules';

describe('attachment-rules', () => {
  it.each(['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])(
    '%s está permitido',
    (mime) => {
      expect(esMimeTypePermitido(mime)).toBe(true);
    },
  );

  it.each(['application/msword', 'image/gif', 'text/plain', ''])(
    '%s no está permitido',
    (mime) => {
      expect(esMimeTypePermitido(mime)).toBe(false);
    },
  );

  it('mapea cada mime permitido a su extensión', () => {
    expect(extensionParaMimeType('application/pdf')).toBe('pdf');
    expect(extensionParaMimeType('image/jpeg')).toBe('jpg');
    expect(extensionParaMimeType('image/png')).toBe('png');
    expect(extensionParaMimeType('image/webp')).toBe('webp');
  });

  it('el límite de tamaño es 10 MB', () => {
    expect(MAX_ATTACHMENT_SIZE_BYTES).toBe(10 * 1024 * 1024);
  });

  describe('decodificarNombreDeArchivo', () => {
    it('reconstruye un nombre UTF-8 que multer leyó como latin1', () => {
      const comoLlega = Buffer.from('póliza ñandú.pdf', 'utf8').toString(
        'latin1',
      );
      expect(decodificarNombreDeArchivo(comoLlega)).toBe('póliza ñandú.pdf');
    });

    it('deja igual un nombre ASCII', () => {
      expect(decodificarNombreDeArchivo('poliza.pdf')).toBe('poliza.pdf');
    });

    it('deja igual un nombre que ya viene decodificado', () => {
      expect(decodificarNombreDeArchivo('póliza €.pdf')).toBe('póliza €.pdf');
    });

    it('deja igual un nombre latin1 que no es UTF-8 válido', () => {
      expect(decodificarNombreDeArchivo('p\u00f3liza.pdf')).toBe('póliza.pdf');
    });
  });
});
