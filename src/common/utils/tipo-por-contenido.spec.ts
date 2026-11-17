import { imagenesDePrueba } from '../../s3/imagenes-de-prueba';
import { tipoPorContenido } from './attachment-rules';
import { zipDePrueba as zipDe } from './zip-de-prueba';

const PDF = Buffer.from('%PDF-1.4\n%prueba\n');

describe('tipoPorContenido: el tipo por la firma, no por la extensión', () => {
  it('reconoce PDF, PNG, JPG y WEBP aunque el nombre y el tipo declarado mientan', async () => {
    expect(tipoPorContenido(PDF, 'foto.jpg', 'image/jpeg')).toBe(
      'application/pdf',
    );
    expect(
      tipoPorContenido(
        await imagenesDePrueba.png(),
        'remito.pdf',
        'application/pdf',
      ),
    ).toBe('image/png');
    expect(
      tipoPorContenido(
        await imagenesDePrueba.jpeg(),
        'a',
        'application/octet-stream',
      ),
    ).toBe('image/jpeg');
    expect(
      tipoPorContenido(await imagenesDePrueba.webp(), 'a.webp', 'image/webp'),
    ).toBe('image/webp');
  });

  it('un ejecutable o un HTML con nombre de PDF no es nada', () => {
    expect(
      tipoPorContenido(
        Buffer.from('MZ\x90\x00'),
        'factura.pdf',
        'application/pdf',
      ),
    ).toBeNull();
    expect(
      tipoPorContenido(
        Buffer.from('<html></html>'),
        'x.pdf',
        'application/pdf',
      ),
    ).toBeNull();
  });

  it('un CSV es texto plano que dice ser CSV (por el nombre o el tipo)', () => {
    const csv = Buffer.from('a;b\n1;2\n');
    expect(tipoPorContenido(csv, 'datos.csv', 'text/plain')).toBe('text/csv');
    expect(tipoPorContenido(csv, 'datos', 'text/csv')).toBe('text/csv');
    expect(tipoPorContenido(csv, 'datos.txt', 'text/plain')).toBeNull();
    expect(
      tipoPorContenido(Buffer.from('<script>'), 'x.csv', 'text/csv'),
    ).toBeNull();
  });
});

describe('tipoPorContenido: Office con macros renombrado no pasa', () => {
  const XLSX = [
    '[Content_Types].xml',
    'xl/workbook.xml',
    'xl/worksheets/sheet1.xml',
  ];
  const DOCX = ['[Content_Types].xml', 'word/document.xml'];

  it('un xlsx y un docx limpios se reconocen', () => {
    expect(tipoPorContenido(zipDe(XLSX), 'a.xlsx', 'x')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(tipoPorContenido(zipDe(DOCX), 'a.docx', 'x')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('un XLSM (con vbaProject.bin o hojas de macros) renombrado a .xlsx no es nada', () => {
    expect(
      tipoPorContenido(zipDe([...XLSX, 'xl/vbaProject.bin']), 'a.xlsx', 'x'),
    ).toBeNull();
    expect(
      tipoPorContenido(
        zipDe([...XLSX, 'xl/macrosheets/sheet1.xml']),
        'a.xlsx',
        'x',
      ),
    ).toBeNull();
  });

  it('un DOCM (con vbaProject.bin o vbaData.xml) renombrado a .docx no es nada', () => {
    expect(
      tipoPorContenido(zipDe([...DOCX, 'word/vbaProject.bin']), 'a.docx', 'x'),
    ).toBeNull();
    expect(
      tipoPorContenido(zipDe([...DOCX, 'word/vbaData.xml']), 'a.docx', 'x'),
    ).toBeNull();
  });

  it('con un ActiveX u objeto incrustado, tampoco', () => {
    expect(
      tipoPorContenido(zipDe([...DOCX, 'word/activeX/activeX1.bin']), 'a', 'x'),
    ).toBeNull();
    expect(
      tipoPorContenido(
        zipDe([...XLSX, 'xl/embeddings/oleObject1.bin']),
        'a',
        'x',
      ),
    ).toBeNull();
  });
});
