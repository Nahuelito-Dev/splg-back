import {
  CSV_MIME_TYPE,
  DOCX_MIME_TYPE,
  esImagenPermitida,
  XLSX_MIME_TYPE,
  type AllowedDocumentMimeType,
} from '../../common/utils/attachment-rules';
import { AttachmentScanStatus } from '../../attachment/attachment-scan-status';
import { Channel, MessageKind } from './chat.enums';

/**
 * Adjuntos del chat (CH7, diseño §9.2): qué tipos y hasta qué tamaño acepta
 * cada canal (las dos puntas de un canal tienen la misma regla). Puro: lo usan el servicio (antes de subir nada)
 * y los tests; la base repite los tipos y el tope general en
 * `CHK_attachment_chat_tipo` y `CHK_attachment_chat_tamano`.
 */

/**
 * C4 (chofer ↔ cliente) todavía no existe en el back (llega con CH5): su regla
 * queda escrita acá para que el canal nazca con ella (sólo fotos, D-C13).
 */
export const CANAL_CHOFER_CLIENTE = 'driver_customer';

export type CanalConAdjuntos = Channel | typeof CANAL_CHOFER_CLIENTE;

const MB = 1024 * 1024;

/** Tope de una foto en C2, C3 y C4. */
export const TOPE_DE_FOTO_DEL_CHAT = 5 * MB;
/** Tope de un archivo (y de una foto en C1). */
export const TOPE_DE_ARCHIVO_DEL_CHAT = 10 * MB;
/** El mayor de todos: el corte de multer en el stream. */
export const TOPE_MAXIMO_DEL_CHAT = TOPE_DE_ARCHIVO_DEL_CHAT;

/** Adjuntos por persona, por empresa y por día (§9.2). */
export const ADJUNTOS_POR_DIA = 30;

/** Largo máximo del epígrafe de un adjunto (§6.5). */
export const LARGO_DEL_EPIGRAFE = 500;

const FOTOS: readonly AllowedDocumentMimeType[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
];
const FOTOS_Y_PDF: readonly AllowedDocumentMimeType[] = [
  ...FOTOS,
  'application/pdf',
];
const DE_OFICINA: readonly AllowedDocumentMimeType[] = [
  ...FOTOS_Y_PDF,
  DOCX_MIME_TYPE,
  XLSX_MIME_TYPE,
  CSV_MIME_TYPE,
];

/** Todos los tipos que algún canal acepta (lo repite el CHECK de la base). */
export const TIPOS_DEL_CHAT: readonly AllowedDocumentMimeType[] = DE_OFICINA;

/** Lo que acepta un canal para quien sube. */
export interface ReglaDeAdjuntos {
  tipos: readonly AllowedDocumentMimeType[];
  topeDeFoto: number;
  topeDeArchivo: number;
  /** Cómo se dicen los tipos en el 415. */
  tiposEnTexto: string;
}

/**
 * La regla de §9.2. C1 (chat con la plataforma y tickets): PDF, fotos, Word,
 * Excel y CSV hasta 10 MB. C2 y C3: fotos (5 MB) y PDF (10 MB), para la
 * empresa y para la persona. C4: sólo fotos de hasta 5 MB.
 */
export function reglaDeAdjuntos(canal: CanalConAdjuntos): ReglaDeAdjuntos {
  if (canal === Channel.PLATFORM_CHAT || canal === Channel.PLATFORM_TICKET) {
    return {
      tipos: DE_OFICINA,
      topeDeFoto: TOPE_DE_ARCHIVO_DEL_CHAT,
      topeDeArchivo: TOPE_DE_ARCHIVO_DEL_CHAT,
      tiposEnTexto: 'PDF, JPG, PNG, WEBP, Word (.docx), Excel (.xlsx) o CSV',
    };
  }
  if (canal === CANAL_CHOFER_CLIENTE) {
    return {
      tipos: FOTOS,
      topeDeFoto: TOPE_DE_FOTO_DEL_CHAT,
      topeDeArchivo: TOPE_DE_FOTO_DEL_CHAT,
      tiposEnTexto: 'fotos JPG, PNG o WEBP',
    };
  }
  // C2 y C3: la empresa y la persona, lo mismo (comprobantes, remitos).
  return {
    tipos: FOTOS_Y_PDF,
    topeDeFoto: TOPE_DE_FOTO_DEL_CHAT,
    topeDeArchivo: TOPE_DE_ARCHIVO_DEL_CHAT,
    tiposEnTexto: 'PDF, JPG, PNG o WEBP',
  };
}

/** Qué se mandó, para la vista previa y los avisos: una foto o un archivo. */
export type MedioDelAdjunto = 'photo' | 'file';

export function medioDe(mime: AllowedDocumentMimeType): MedioDelAdjunto {
  return esImagenPermitida(mime) ? 'photo' : 'file';
}

/** El tope que le toca a ese archivo en ese canal. */
export function topeDe(
  regla: ReglaDeAdjuntos,
  mime: AllowedDocumentMimeType,
): number {
  return medioDe(mime) === 'photo' ? regla.topeDeFoto : regla.topeDeArchivo;
}

/** Vista previa de la bandeja y de las listas: «📎 Foto» o «📎 Archivo». */
export function vistaPreviaDelAdjunto(medio: MedioDelAdjunto): string {
  return medio === 'photo' ? '📎 Foto' : '📎 Archivo';
}

/** El medio guardado en el `payload` del mensaje de adjunto; nulo si no lo es. */
export function medioDelMensaje(m: {
  kind: MessageKind;
  payload: unknown;
}): MedioDelAdjunto | null {
  if (m.kind !== MessageKind.ATTACHMENT) return null;
  const media =
    typeof m.payload === 'object' && m.payload !== null
      ? (m.payload as Record<string, unknown>).media
      : undefined;
  return media === 'photo' || media === 'file' ? media : 'file';
}

/** Qué responde la descarga según el escaneo y quién pide. */
export type LecturaDelAdjunto =
  | 'firmar'
  | 'pendiente'
  | 'bloqueado'
  | 'fallido';

/**
 * `pending` → 409 (todavía se verifica); `infected` → 404 (oculto); `failed`
 * → 409 para todos, también el personal: un archivo que el antivirus no pudo
 * revisar no se baja (se reintenta; ver `MAX_INTENTOS_DE_ESCANEO`).
 */
export function lecturaDelAdjunto(
  estado: AttachmentScanStatus,
): LecturaDelAdjunto {
  switch (estado) {
    case AttachmentScanStatus.PENDING:
      return 'pendiente';
    case AttachmentScanStatus.INFECTED:
      return 'bloqueado';
    case AttachmentScanStatus.FAILED:
      return 'fallido';
    default:
      return 'firmar';
  }
}

/**
 * Intentos de escaneo de un archivo antes de darlo por no verificable (queda
 * `failed` y la tarea programada ya no lo retoma). Cada pasada hace hasta 3.
 */
export const MAX_INTENTOS_DE_ESCANEO = 15;

/** Escaneos simultáneos por proceso (bajar de S3 y mandar a clamd). */
export const ESCANEOS_SIMULTANEOS = 2;

/**
 * El estado que deja un resultado sobre el actual, o `null` si no lo cambia:
 * sólo se escanea lo `pending` o `failed`; `clean` e `infected` son finales.
 * Así `infected` gana siempre sobre `failed` (si una pasada falló y otra
 * encontró el virus, queda infectado) y un `failed` nunca pisa un resultado.
 */
export function estadoTrasEscanear(
  actual: AttachmentScanStatus,
  resultado: AttachmentScanStatus,
): AttachmentScanStatus | null {
  const reintentable =
    actual === AttachmentScanStatus.PENDING ||
    actual === AttachmentScanStatus.FAILED;
  return reintentable ? resultado : null;
}

/** Estado inicial: una foto ya quedó limpia al re-codificarla; el resto espera al escáner. */
export function escaneoInicial(
  mime: AllowedDocumentMimeType,
): AttachmentScanStatus {
  return medioDe(mime) === 'photo'
    ? AttachmentScanStatus.CLEAN
    : AttachmentScanStatus.PENDING;
}
