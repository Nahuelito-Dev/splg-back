/**
 * Reglas de validación de los adjuntos (flota: pólizas, VTV,
 * licencias, comprobantes de service; y los adjuntos genéricos de empresa): qué tipos de archivo se aceptan y
 * hasta qué tamaño. Puro: sin `@nestjs/common` ni Multer, para poder
 * probarlo sin levantar el módulo.
 */
export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type AllowedAttachmentMimeType =
  (typeof ALLOWED_ATTACHMENT_MIME_TYPES)[number];

export const DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const CSV_MIME_TYPE = 'text/csv';

/**
 * Lo que aceptan los adjuntos genéricos de empresa: lo de arriba más Word
 * (.docx), Excel (.xlsx) y CSV. Los adjuntos de flota y las fotos de reclamos
 * siguen con {@link ALLOWED_ATTACHMENT_MIME_TYPES}.
 */
export const ALLOWED_DOCUMENT_MIME_TYPES = [
  ...ALLOWED_ATTACHMENT_MIME_TYPES,
  DOCX_MIME_TYPE,
  XLSX_MIME_TYPE,
  CSV_MIME_TYPE,
] as const;

export type AllowedDocumentMimeType =
  (typeof ALLOWED_DOCUMENT_MIME_TYPES)[number];

/** Las imágenes que se aceptan como foto (reclamos): los mismos formatos, sin PDF. */
export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export function esImagenPermitida(
  mimeType: string,
): mimeType is Exclude<AllowedAttachmentMimeType, 'application/pdf'> {
  return (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

/** 10 MB: de sobra para una foto o un PDF escaneado de una póliza/VTV/licencia. */
export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;

export function esMimeTypePermitido(
  mimeType: string,
): mimeType is AllowedAttachmentMimeType {
  return (ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(
    mimeType,
  );
}

export function esDocumentoPermitido(
  mimeType: string,
): mimeType is AllowedDocumentMimeType {
  return (ALLOWED_DOCUMENT_MIME_TYPES as readonly string[]).includes(mimeType);
}

/** Extensión de archivo por mime type, para armar la key del objeto en S3. */
export function extensionParaMimeType(
  mimeType: AllowedDocumentMimeType,
): string {
  const extensiones: Record<AllowedDocumentMimeType, string> = {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    [DOCX_MIME_TYPE]: 'docx',
    [XLSX_MIME_TYPE]: 'xlsx',
    [CSV_MIME_TYPE]: 'csv',
  };
  return extensiones[mimeType];
}

/**
 * Multer entrega `originalname` decodificado como latin1 aunque el navegador
 * lo haya mandado en UTF-8: "póliza.pdf" llega como "pÃ³liza.pdf". Si el
 * nombre es el resultado de leer bytes UTF-8 como latin1 lo reconstruye; si
 * ya viene bien (algún carácter fuera de latin1, o bytes que no son UTF-8
 * válido) lo deja como está.
 */
export function decodificarNombreDeArchivo(nombre: string): string {
  if ([...nombre].some((c) => c.charCodeAt(0) > 0xff)) return nombre;
  const decodificado = Buffer.from(nombre, 'latin1').toString('utf8');
  return decodificado.includes('�') ? nombre : decodificado;
}

/**
 * ¿Los primeros bytes del archivo son los de su tipo declarado? El header
 * `Content-Type` lo manda el cliente y no prueba nada: un HTML o un ejecutable
 * puede venir como `image/png`. Se mira la firma (magic number) de cada formato.
 */
export function firmaCoincideConMimeType(
  mimeType: AllowedDocumentMimeType,
  buffer: Buffer,
): boolean {
  const empieza = (bytes: number[], desde = 0): boolean =>
    buffer.length >= desde + bytes.length &&
    bytes.every((b, i) => buffer[desde + i] === b);

  switch (mimeType) {
    case 'application/pdf':
      return empieza([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
    case 'image/png':
      return empieza([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return empieza([0xff, 0xd8, 0xff]);
    case 'image/webp':
      return (
        empieza([0x52, 0x49, 0x46, 0x46]) && // RIFF
        empieza([0x57, 0x45, 0x42, 0x50], 8) // WEBP
      );
    case DOCX_MIME_TYPE:
      return esPaqueteOffice(buffer, 'word/document.xml', 'word');
    case XLSX_MIME_TYPE:
      return esPaqueteOffice(buffer, 'xl/workbook.xml', 'xl');
    case CSV_MIME_TYPE:
      return esTextoPlano(buffer);
  }
}

const FIRMA_ZIP = [0x50, 0x4b, 0x03, 0x04];
const FIRMA_FIN_DE_DIRECTORIO = 0x06054b50;
const FIRMA_ENTRADA_DE_DIRECTORIO = 0x02014b50;
/** El comentario del ZIP mide a lo sumo 65535 bytes; el registro final, 22. */
const MAX_COLA_DEL_ZIP = 65535 + 22;
const MAX_ENTRADAS_DEL_ZIP = 10_000;

/**
 * Los nombres de las entradas de un ZIP, leídos del directorio central sin
 * descomprimir nada (un zip bomb no cuesta memoria). `null` si no es un ZIP
 * bien formado.
 */
export function entradasDeZip(buffer: Buffer): string[] | null {
  if (buffer.length < 22) return null;
  if (!FIRMA_ZIP.every((b, i) => buffer[i] === b)) return null;

  const desde = Math.max(0, buffer.length - MAX_COLA_DEL_ZIP);
  let fin = -1;
  for (let i = buffer.length - 22; i >= desde; i--) {
    if (buffer.readUInt32LE(i) === FIRMA_FIN_DE_DIRECTORIO) {
      fin = i;
      break;
    }
  }
  if (fin < 0) return null;

  const total = buffer.readUInt16LE(fin + 10);
  let pos = buffer.readUInt32LE(fin + 16);
  if (total === 0 || total > MAX_ENTRADAS_DEL_ZIP) return null;

  const nombres: string[] = [];
  for (let n = 0; n < total; n++) {
    if (
      pos + 46 > buffer.length ||
      buffer.readUInt32LE(pos) !== FIRMA_ENTRADA_DE_DIRECTORIO
    ) {
      return null;
    }
    const largoNombre = buffer.readUInt16LE(pos + 28);
    const largoExtra = buffer.readUInt16LE(pos + 30);
    const largoComentario = buffer.readUInt16LE(pos + 32);
    if (pos + 46 + largoNombre > buffer.length) return null;
    nombres.push(buffer.toString('utf8', pos + 46, pos + 46 + largoNombre));
    pos += 46 + largoNombre + largoExtra + largoComentario;
  }
  return nombres;
}

/** Entradas que no tienen lugar en un documento: macros y ejecutables. */
const ENTRADA_PELIGROSA =
  /(^|\/)vbaProject[^/]*\.bin$|(^|\/)vbaData\.xml$|(^|\/)(activeX|macrosheets|embeddings)\/|\.(exe|dll|js|vbs|vbe|bat|cmd|ps1|scr|jar|com|msi|sh|bin)$/i;

/** `.bin` que Office genera de verdad y no ejecutan nada. */
const BIN_INOFENSIVO = /(^|\/)printerSettings\/printerSettings\d+\.bin$/i;

/**
 * Un .docx o .xlsx es un ZIP (OPC). Se exige que:
 * - tenga `[Content_Types].xml` y la parte principal del documento;
 * - todas las entradas estén en las carpetas de un OOXML de ese tipo
 *   (`_rels`, `docProps`, `customXml` y `word` o `xl`, según el tipo);
 * - ninguna sea una macro (`vbaProject.bin`, hojas de macros, ActiveX) ni un
 *   objeto incrustado, ni un ejecutable o script por su extensión, ni un
 *   nombre con `..` o ruta absoluta.
 * No descomprime ni analiza el contenido de las partes XML: es un filtro por
 * estructura, no un antivirus.
 */
function esPaqueteOffice(
  buffer: Buffer,
  parteDelDocumento: string,
  carpetaDelTipo: 'word' | 'xl',
): boolean {
  const nombres = entradasDeZip(buffer);
  if (
    nombres === null ||
    !nombres.includes('[Content_Types].xml') ||
    !nombres.includes(parteDelDocumento)
  ) {
    return false;
  }
  const carpetas = ['_rels', 'docProps', 'customXml', carpetaDelTipo];
  return nombres.every((nombre) => {
    if (nombre.startsWith('/') || nombre.split('/').includes('..')) {
      return false;
    }
    if (nombre === '[Content_Types].xml' || nombre.endsWith('/')) return true;
    if (!carpetas.includes(nombre.split('/')[0])) return false;
    return !ENTRADA_PELIGROSA.test(nombre) || BIN_INOFENSIVO.test(nombre);
  });
}

/**
 * ¿Parece texto? UTF-8 válido o, si no, Windows-1252/Latin-1 (el CSV que
 * guarda Excel en Windows): sin bytes nulos ni caracteres de control
 * (salvo tab, salto de línea y retorno) y que no arranque como HTML o XML.
 * Es lo único que se le puede exigir a un CSV, que no tiene firma. Igual se
 * entrega siempre como descarga, nunca inline.
 */
function esTextoPlano(buffer: Buffer): boolean {
  for (const byte of buffer) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      return false;
    }
    if (byte === 0x7f) return false;
  }
  let texto: string;
  try {
    texto = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    texto = buffer.toString('latin1');
  }
  return !texto.trimStart().startsWith('<');
}

/**
 * Excel en Windows manda los CSV como `application/vnd.ms-excel`. Si el
 * archivo se llama `.csv` se trata como `text/csv` (después se valida que el
 * contenido sea texto); el resto de los tipos pasa igual.
 */
export function normalizarMimeDeCsv(mimeType: string, nombre: string): string {
  return mimeType.toLowerCase() === 'application/vnd.ms-excel' &&
    /\.csv$/i.test(nombre.trim())
    ? CSV_MIME_TYPE
    : mimeType;
}

/** Largo máximo de `original_name` en la base (varchar 255). */
export const MAX_NOMBRE_DE_ARCHIVO = 255;

/**
 * Recorta el nombre al máximo de la columna conservando la extensión, para que
 * un nombre larguísimo no termine en un 500 de la base.
 */
export function acotarNombreDeArchivo(
  nombre: string,
  max = MAX_NOMBRE_DE_ARCHIVO,
): string {
  const chars = [...nombre];
  if (chars.length <= max) return nombre;
  const punto = nombre.lastIndexOf('.');
  const extension =
    punto > 0 && nombre.length - punto <= 10 ? nombre.slice(punto) : '';
  const base = [...nombre.slice(0, punto > 0 ? punto : nombre.length)];
  return base.slice(0, max - [...extension].length).join('') + extension;
}

/**
 * El tipo del archivo según su CONTENIDO, sin creer en la extensión ni en el
 * tipo que declaró el cliente: la firma de PDF, JPG, PNG y WEBP, el paquete de
 * Office con su documento interno para Word y Excel. El CSV no tiene firma: se
 * toma como CSV sólo si es texto plano y quien lo manda dice que es un CSV
 * (por el nombre `.csv` o el tipo declarado). `null` si no es ninguno.
 */
export function tipoPorContenido(
  buffer: Buffer,
  nombre: string,
  declarado: string,
): AllowedDocumentMimeType | null {
  const conFirma: AllowedDocumentMimeType[] = [
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    DOCX_MIME_TYPE,
    XLSX_MIME_TYPE,
  ];
  const tipo = conFirma.find((t) => firmaCoincideConMimeType(t, buffer));
  if (tipo) return tipo;
  const diceCsv =
    /\.csv$/i.test(nombre.trim()) ||
    normalizarMimeDeCsv(declarado, nombre).toLowerCase() === CSV_MIME_TYPE;
  return diceCsv && firmaCoincideConMimeType(CSV_MIME_TYPE, buffer)
    ? CSV_MIME_TYPE
    : null;
}
