import {
  decodificarNombreDeArchivo,
  esMimeTypePermitido,
  acotarNombreDeArchivo,
  extensionParaMimeType,
  firmaCoincideConMimeType,
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

describe('firmaCoincideConMimeType', () => {
  const casos: Array<[Parameters<typeof firmaCoincideConMimeType>[0], Buffer]> =
    [
      ['application/pdf', Buffer.from('%PDF-1.7 x')],
      [
        'image/png',
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
      ],
      ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0])],
      [
        'image/webp',
        Buffer.concat([
          Buffer.from('RIFF'),
          Buffer.alloc(4),
          Buffer.from('WEBPVP8 '),
        ]),
      ],
    ];

  it.each(casos)('acepta la firma real de %s', (mime, buffer) => {
    expect(firmaCoincideConMimeType(mime, buffer)).toBe(true);
  });

  it.each(casos)('rechaza un HTML declarado como %s', (mime) => {
    expect(firmaCoincideConMimeType(mime, Buffer.from('<html><script>'))).toBe(
      false,
    );
  });

  it('rechaza un buffer más corto que la firma', () => {
    expect(firmaCoincideConMimeType('image/png', Buffer.from([0x89]))).toBe(
      false,
    );
  });
});

describe('acotarNombreDeArchivo', () => {
  it('deja intacto un nombre que entra', () => {
    expect(acotarNombreDeArchivo('dni.pdf')).toBe('dni.pdf');
  });

  it('recorta a 255 conservando la extensión', () => {
    const r = acotarNombreDeArchivo(`${'a'.repeat(400)}.pdf`);
    expect([...r].length).toBe(255);
    expect(r.endsWith('.pdf')).toBe(true);
  });

  it('sin extensión recorta igual', () => {
    expect([...acotarNombreDeArchivo('b'.repeat(400))].length).toBe(255);
  });
});
