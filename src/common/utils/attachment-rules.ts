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

/** 10 MB: de sobra para una foto o un PDF escaneado de una póliza/VTV/licencia. */
export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;

export function esMimeTypePermitido(
  mimeType: string,
): mimeType is AllowedAttachmentMimeType {
  return (ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(
    mimeType,
  );
}

/** Extensión de archivo por mime type, para armar la key del storage. */
export function extensionParaMimeType(
  mimeType: AllowedAttachmentMimeType,
): string {
  const extensiones: Record<AllowedAttachmentMimeType, string> = {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
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
  mimeType: AllowedAttachmentMimeType,
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
  }
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
