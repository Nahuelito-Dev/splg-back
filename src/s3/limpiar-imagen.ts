import {
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import sharp from 'sharp';
import {
  esImagenPermitida,
  type AllowedDocumentMimeType,
} from '../common/utils/attachment-rules';

/**
 * Tope de megapíxeles de una imagen subida (24 MP). Una foto de celular ronda
 * los 12 MP; un JPEG chico puede declarar 49 MP y ocupar cientos de MB al
 * decodificarse, así que el tamaño en píxeles se lee del encabezado ANTES de
 * decodificar y lo que pasa el tope se rechaza con 413.
 */
export const MAX_PIXELES = 24_000_000;

/** Calidad al recodificar JPEG y WEBP. */
const CALIDAD = 90;

/** Imágenes que se procesan a la vez: acota la memoria bajo carga. */
const MAX_PROCESOS_SIMULTANEOS = 2;

// Un hilo por operación y sin caché de libvips: la concurrencia la gobierna el
// semáforo, no el pool interno.
sharp.concurrency(1);
sharp.cache(false);

/** Semáforo mínimo en memoria (las instancias son independientes entre sí). */
export class Semaforo {
  private libres: number;
  private readonly cola: Array<() => void> = [];

  constructor(cupo: number) {
    this.libres = cupo;
  }

  async correr<T>(trabajo: () => Promise<T>): Promise<T> {
    if (this.libres > 0) {
      this.libres -= 1;
    } else {
      await new Promise<void>((resolver) => this.cola.push(resolver));
    }
    try {
      return await trabajo();
    } finally {
      const siguiente = this.cola.shift();
      if (siguiente) siguiente();
      else this.libres += 1;
    }
  }
}

const semaforo = new Semaforo(MAX_PROCESOS_SIMULTANEOS);

/**
 * Re-codifica una imagen sin su metadata: ningún archivo sale del back con GPS,
 * EXIF, XMP, IPTC ni comentarios. Se aplica la orientación del EXIF a los
 * píxeles antes de descartarlo (la foto no queda de costado). El formato no
 * cambia. El PDF, Word, Excel y CSV pasan sin tocarse.
 *
 * - Más de {@link MAX_PIXELES} (leído del encabezado, sin decodificar): 413.
 * - Una imagen que no se puede decodificar (la firma coincidía pero el
 *   contenido está dañado): 415.
 * - A lo sumo {@link MAX_PROCESOS_SIMULTANEOS} imágenes en proceso a la vez.
 */
export async function limpiarMetadatosDeImagen(
  buffer: Buffer,
  mime: AllowedDocumentMimeType,
): Promise<Buffer> {
  if (!esImagenPermitida(mime)) return buffer;
  return semaforo.correr(async () => {
    const opciones = {
      failOn: 'error',
      limitInputPixels: MAX_PIXELES,
    } as const;
    try {
      // `metadata()` sólo lee el encabezado: no decodifica los píxeles.
      const { width, height } = await sharp(buffer, {
        ...opciones,
        limitInputPixels: false,
      }).metadata();
      if (width && height && width * height > MAX_PIXELES) {
        throw new PayloadTooLargeException(
          `La imagen es demasiado grande (${width}×${height}): el máximo es ${MAX_PIXELES / 1_000_000} megapíxeles`,
        );
      }
      const imagen = sharp(buffer, opciones).rotate();
      switch (mime) {
        case 'image/jpeg':
          return await imagen.jpeg({ quality: CALIDAD }).toBuffer();
        case 'image/png':
          return await imagen.png().toBuffer();
        case 'image/webp':
          return await imagen.webp({ quality: CALIDAD }).toBuffer();
      }
    } catch (error) {
      if (error instanceof PayloadTooLargeException) throw error;
      throw new UnsupportedMediaTypeException(
        'No se pudo leer la imagen: el archivo está dañado o no es una imagen válida',
      );
    }
  });
}
