import { zipDePrueba } from './zip-de-prueba';
import {
  decodificarNombreDeArchivo,
  DOCX_MIME_TYPE,
  XLSX_MIME_TYPE,
  CSV_MIME_TYPE,
  entradasDeZip,
  normalizarMimeDeCsv,
  esDocumentoPermitido,
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

describe('adjuntos de documentos: Word, Excel y CSV', () => {
  const DOCX = zipDePrueba([
    '[Content_Types].xml',
    '_rels/.rels',
    'word/document.xml',
  ]);
  const XLSX = zipDePrueba([
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/workbook.xml',
  ]);

  it.each([DOCX_MIME_TYPE, XLSX_MIME_TYPE, CSV_MIME_TYPE, 'application/pdf'])(
    '%s se acepta como documento',
    (mime) => {
      expect(esDocumentoPermitido(mime)).toBe(true);
    },
  );

  it.each(['application/msword', 'application/vnd.ms-excel', 'text/html', ''])(
    '%s no se acepta como documento',
    (mime) => {
      expect(esDocumentoPermitido(mime)).toBe(false);
    },
  );

  it('Word, Excel y CSV no entran en la lista de flota y reclamos', () => {
    expect(esMimeTypePermitido(DOCX_MIME_TYPE)).toBe(false);
    expect(esMimeTypePermitido(XLSX_MIME_TYPE)).toBe(false);
    expect(esMimeTypePermitido(CSV_MIME_TYPE)).toBe(false);
  });

  it('mapea cada documento a su extensión', () => {
    expect(extensionParaMimeType(DOCX_MIME_TYPE)).toBe('docx');
    expect(extensionParaMimeType(XLSX_MIME_TYPE)).toBe('xlsx');
    expect(extensionParaMimeType(CSV_MIME_TYPE)).toBe('csv');
  });

  it('acepta un docx y un xlsx con su estructura', () => {
    expect(firmaCoincideConMimeType(DOCX_MIME_TYPE, DOCX)).toBe(true);
    expect(firmaCoincideConMimeType(XLSX_MIME_TYPE, XLSX)).toBe(true);
  });

  it('un docx no vale como xlsx ni al revés', () => {
    expect(firmaCoincideConMimeType(XLSX_MIME_TYPE, DOCX)).toBe(false);
    expect(firmaCoincideConMimeType(DOCX_MIME_TYPE, XLSX)).toBe(false);
  });

  it('rechaza un ZIP cualquiera, sin [Content_Types].xml', () => {
    const zip = zipDePrueba(['word/document.xml', 'macros.exe']);
    expect(firmaCoincideConMimeType(DOCX_MIME_TYPE, zip)).toBe(false);
  });

  it('rechaza un ejecutable o un HTML declarados como docx/xlsx', () => {
    expect(
      firmaCoincideConMimeType(DOCX_MIME_TYPE, Buffer.from('MZ\x90\x00')),
    ).toBe(false);
    expect(
      firmaCoincideConMimeType(XLSX_MIME_TYPE, Buffer.from('<html></html>')),
    ).toBe(false);
  });

  it('rechaza un ZIP truncado (sin directorio central)', () => {
    expect(
      firmaCoincideConMimeType(
        DOCX_MIME_TYPE,
        DOCX.subarray(0, DOCX.length - 30),
      ),
    ).toBe(false);
  });

  it('lee el directorio aunque el ZIP traiga comentario al final', () => {
    const conComentario = zipDePrueba(
      ['[Content_Types].xml', 'word/document.xml'],
      'comentario del zip',
    );
    expect(entradasDeZip(conComentario)).toEqual([
      '[Content_Types].xml',
      'word/document.xml',
    ]);
  });

  it('un CSV es texto UTF-8 sin bytes nulos', () => {
    expect(
      firmaCoincideConMimeType(
        CSV_MIME_TYPE,
        Buffer.from('nombre;edad\nAna;30\n'),
      ),
    ).toBe(true);
    expect(
      firmaCoincideConMimeType(CSV_MIME_TYPE, Buffer.from('ñandú,1\n', 'utf8')),
    ).toBe(true);
  });

  it.each([
    ['con un byte nulo', Buffer.from([0x61, 0x2c, 0x00, 0x62])],
    ['que arranca como HTML', Buffer.from('  <script>alert(1)</script>')],
  ])('rechaza un CSV %s', (_caso, buffer) => {
    expect(firmaCoincideConMimeType(CSV_MIME_TYPE, buffer)).toBe(false);
  });
});

describe('docx/xlsx: macros, ejecutables y entradas fuera de lugar', () => {
  const base = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'];
  const baseXlsx = ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml'];

  it.each([
    'word/vbaProject.bin',
    'word/embeddings/oleObject1.bin',
    'word/activeX/activeX1.xml',
    'word/malo.exe',
    'word/malo.dll',
    'word/malo.js',
    'word/malo.vbs',
    'word/malo.bat',
    'word/malo.cmd',
    'word/malo.ps1',
    'word/malo.scr',
    'word/malo.jar',
    'afuera/cualquiera.xml',
    'setup.exe',
    '../escapa.xml',
    '/absoluta.xml',
  ])('un docx con la entrada "%s" se rechaza', (entrada) => {
    expect(
      firmaCoincideConMimeType(DOCX_MIME_TYPE, zipDePrueba([...base, entrada])),
    ).toBe(false);
  });

  it.each(['xl/vbaProject.bin', 'xl/macrosheets/sheet1.xml', 'xl/x.vbs'])(
    'un xlsx con la entrada "%s" se rechaza',
    (entrada) => {
      expect(
        firmaCoincideConMimeType(
          XLSX_MIME_TYPE,
          zipDePrueba([...baseXlsx, entrada]),
        ),
      ).toBe(false);
    },
  );

  it('un xlsx no puede traer la carpeta word/ ni un docx la xl/', () => {
    expect(
      firmaCoincideConMimeType(
        XLSX_MIME_TYPE,
        zipDePrueba([...baseXlsx, 'word/document.xml']),
      ),
    ).toBe(false);
    expect(
      firmaCoincideConMimeType(
        DOCX_MIME_TYPE,
        zipDePrueba([...base, 'xl/workbook.xml']),
      ),
    ).toBe(false);
  });

  it('acepta las entradas normales de Office, carpetas y el printerSettings.bin', () => {
    expect(
      firmaCoincideConMimeType(
        XLSX_MIME_TYPE,
        zipDePrueba([
          ...baseXlsx,
          'docProps/app.xml',
          'customXml/item1.xml',
          'xl/',
          'xl/worksheets/sheet1.xml',
          'xl/printerSettings/printerSettings1.bin',
        ]),
      ),
    ).toBe(true);
  });
});

describe('CSV de Excel en Windows', () => {
  it('acepta Windows-1252 con acentos y eñes', () => {
    const ansi = Buffer.from(
      'nombre;ciudad\nJosé;Córdoba\nPeña;Añelo\n',
      'latin1',
    );
    expect(ansi.includes(0xe9)).toBe(true);
    expect(firmaCoincideConMimeType(CSV_MIME_TYPE, ansi)).toBe(true);
  });

  it('un binario con bytes de control sigue rechazado', () => {
    expect(
      firmaCoincideConMimeType(
        CSV_MIME_TYPE,
        Buffer.from([0x61, 0xe9, 0x01, 0x62]),
      ),
    ).toBe(false);
  });

  it('un HTML en Latin-1 sigue rechazado', () => {
    expect(
      firmaCoincideConMimeType(
        CSV_MIME_TYPE,
        Buffer.from('<html>Córdoba</html>', 'latin1'),
      ),
    ).toBe(false);
  });

  it('application/vnd.ms-excel con extensión .csv se trata como text/csv', () => {
    expect(normalizarMimeDeCsv('application/vnd.ms-excel', 'lista.CSV')).toBe(
      CSV_MIME_TYPE,
    );
    expect(normalizarMimeDeCsv('application/vnd.ms-excel', 'lista.xls')).toBe(
      'application/vnd.ms-excel',
    );
    expect(normalizarMimeDeCsv('application/pdf', 'a.csv')).toBe(
      'application/pdf',
    );
  });
});
