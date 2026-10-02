/**
 * Reglas de validación de los adjuntos de una tarea de flota (pólizas, VTV,
 * licencias, comprobantes de service): qué tipos de archivo se aceptan y
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
